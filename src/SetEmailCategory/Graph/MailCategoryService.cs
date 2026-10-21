using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SetEmailCategory.Models;

namespace SetEmailCategory.Graph;

public enum CategoryOutcomeStatus
{
    Success,
    MessageNotFound,
    AmbiguousMessage,
    InvalidMessageId,
    /// <summary>Graph rejected the request with a non-transient 4xx; retrying won't help.</summary>
    GraphRejected,
    MailboxAccessDenied,
    /// <summary>Transient: Graph throttled, unavailable, or the message kept changing. Safe to retry.</summary>
    UpstreamFailure,
    UnexpectedError,
}

public sealed record CategoryOutcome(
    CategoryOutcomeStatus Status,
    string? MessageId = null,
    IReadOnlyList<string>? Categories = null,
    bool Changed = false,
    string? Detail = null,
    string? GraphRequestId = null);

public interface IMailCategoryService
{
    Task<CategoryOutcome> ApplyAsync(ValidatedRequest request, CancellationToken cancellationToken);
}

/// <summary>Reads and updates the categories of a message in the configured shared mailbox via Microsoft Graph.</summary>
public sealed partial class MailCategoryService(
    HttpClient http,
    IOptions<SharedMailboxOptions> options,
    ILogger<MailCategoryService> logger) : IMailCategoryService
{
    /// <summary>Attempts at an update when another writer changes the message at the same time (HTTP 412/409).</summary>
    internal const int MaxConcurrencyAttempts = 3;

    /// <summary>Graph error codes meaning "this ID doesn't identify a message in this mailbox".</summary>
    private static readonly HashSet<string> InvalidIdCodes =
        new(["ErrorInvalidIdMalformed", "ErrorInvalidId", "ErrorInvalidMailboxItemId"], StringComparer.OrdinalIgnoreCase);

    private readonly string _mailboxPath = $"users/{Uri.EscapeDataString(options.Value.Address)}/messages";

    public async Task<CategoryOutcome> ApplyAsync(ValidatedRequest request, CancellationToken cancellationToken)
    {
        try
        {
            if (request.MessageId is not null)
            {
                try
                {
                    return await ApplyToMessageAsync(request.MessageId, request, cancellationToken);
                }
                // Message IDs change when a message is moved between folders, which can easily happen between the
                // email arriving and the (polling) flow trigger firing. Fall back to the stable internetMessageId.
                catch (GraphException ex) when (request.InternetMessageId is not null && IsUnknownMessage(ex))
                {
                    LogFallingBackToInternetMessageId(request.MessageId, ex.StatusCode, ex.Code);
                }
            }

            var lookup = await FindByInternetMessageIdAsync(request.InternetMessageId!, cancellationToken);
            return lookup.Status == CategoryOutcomeStatus.Success
                ? await ApplyToMessageAsync(lookup.MessageId!, request, cancellationToken)
                : lookup;
        }
        catch (GraphException ex)
        {
            return MapGraphError(ex);
        }
        catch (Azure.Identity.AuthenticationFailedException ex)
        {
            LogTokenFailure(ex);
            return new CategoryOutcome(CategoryOutcomeStatus.MailboxAccessDenied,
                Detail: "The function could not obtain a Microsoft Graph token for its managed identity.");
        }
        catch (Exception ex) when (ex is HttpRequestException or TimeoutException or Polly.Timeout.TimeoutRejectedException)
        {
            LogUpstreamUnavailable(ex);
            return new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure, Detail: "Microsoft Graph could not be reached.");
        }
        // Cancellation (deadline, caller disconnect, host shutdown) propagates to the function, which owns the deadline.
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            LogUnexpected(ex);
            return new CategoryOutcome(CategoryOutcomeStatus.UnexpectedError,
                Detail: $"Unexpected {ex.GetType().Name} while updating the message.");
        }
    }

    private async Task<CategoryOutcome> ApplyToMessageAsync(string messageId, ValidatedRequest request, CancellationToken ct)
    {
        var useIfMatch = true;
        string? rejectedETag = null;

        for (var attempt = 1; ; attempt++)
        {
            IReadOnlyList<string> desired;
            string? etag = null;

            if (request.Mode == CategoryMode.Replace)
            {
                // The result doesn't depend on the current categories, so skip the read (one less Graph request
                // against the per-mailbox limit). The trade-off: replace always reports Changed = true.
                desired = request.Categories;
            }
            else
            {
                var current = await GetMessageAsync(messageId, ct);

                // A genuine concurrent change produces a new ETag. If Graph rejected our If-Match (412) yet the
                // message still carries the same ETag, the precondition itself isn't usable (e.g. weak ETags compared
                // strictly), so stop sending it rather than failing every request.
                if (rejectedETag is not null && rejectedETag == current.ETag)
                {
                    useIfMatch = false;
                    LogIfMatchDisabled(messageId);
                }

                desired = Merge(current.Categories, request.Categories, request.Mode);
                if (desired.SequenceEqual(current.Categories, StringComparer.Ordinal))
                {
                    LogNoChange(messageId, request.Mode);
                    return new CategoryOutcome(CategoryOutcomeStatus.Success, current.Id, current.Categories, Changed: false);
                }

                // If-Match makes the read-modify-write safe against a concurrent flow run (or a user in Outlook)
                // changing categories between our GET and PATCH.
                etag = useIfMatch ? current.ETag : null;
            }

            var result = await PatchCategoriesAsync(messageId, desired, etag, ct);
            if (result.Status == PatchStatus.Updated)
            {
                LogUpdated(messageId, request.Mode, result.Message!.Categories.Count);
                return new CategoryOutcome(CategoryOutcomeStatus.Success, result.Message.Id, result.Message.Categories, Changed: true);
            }

            if (attempt >= MaxConcurrencyAttempts)
            {
                return new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure,
                    Detail: "The message kept changing while categories were being updated. Retry the request.");
            }

            rejectedETag = result.Status == PatchStatus.PreconditionFailed ? etag : null;
            LogConcurrencyRetry(messageId, result.Status, attempt);

            // Brief jittered pause so two runs racing on the same message don't collide again immediately.
            await Task.Delay(TimeSpan.FromMilliseconds(Random.Shared.Next(100, 300) * attempt), ct);
        }
    }

    /// <summary>Computes the new category list, preserving the existing order and the existing casing of matches.</summary>
    internal static List<string> Merge(IReadOnlyList<string> existing, IReadOnlyList<string> requested, CategoryMode mode)
    {
        var result = new List<string>(existing);
        switch (mode)
        {
            case CategoryMode.Add:
                foreach (var category in requested)
                {
                    if (!result.Contains(category, StringComparer.OrdinalIgnoreCase))
                    {
                        result.Add(category);
                    }
                }
                break;
            case CategoryMode.Remove:
                result.RemoveAll(c => requested.Contains(c, StringComparer.OrdinalIgnoreCase));
                break;
            case CategoryMode.Replace:
                return [.. requested];
            default:
                // RequestValidator rejects undefined modes; never fall through to a silent "no change".
                throw new ArgumentOutOfRangeException(nameof(mode), mode, "Unsupported category mode.");
        }

        return result;
    }

    private async Task<CategoryOutcome> FindByInternetMessageIdAsync(string internetMessageId, CancellationToken ct)
    {
        // OData string literals escape a single quote by doubling it.
        var filter = $"internetMessageId eq '{internetMessageId.Replace("'", "''", StringComparison.Ordinal)}'";
        var url = $"{_mailboxPath}?$filter={Uri.EscapeDataString(filter)}&$select=id&$top=2";

        using var response = await http.GetAsync(url, ct);
        await EnsureSuccessAsync(response, ct);
        var page = await response.Content.ReadFromJsonAsync<GraphCollection<GraphMessage>>(ct);

        return page?.Value switch
        {
            [var message] => new CategoryOutcome(CategoryOutcomeStatus.Success, message.Id),
            null or [] => new CategoryOutcome(CategoryOutcomeStatus.MessageNotFound,
                Detail: "The message was not found in the shared mailbox (it may have been deleted)."),
            _ => new CategoryOutcome(CategoryOutcomeStatus.AmbiguousMessage,
                Detail: "More than one message has that internetMessageId. Supply 'messageId' instead."),
        };
    }

    private async Task<GraphMessage> GetMessageAsync(string messageId, CancellationToken ct)
    {
        using var response = await http.GetAsync($"{_mailboxPath}/{Uri.EscapeDataString(messageId)}?$select=id,categories", ct);
        await EnsureSuccessAsync(response, ct);
        return await response.Content.ReadFromJsonAsync<GraphMessage>(ct)
            ?? throw new InvalidDataException("Graph returned an empty message body.");
    }

    private enum PatchStatus
    {
        Updated,
        /// <summary>412: our If-Match ETag no longer matches.</summary>
        PreconditionFailed,
        /// <summary>409: Exchange reported a conflicting concurrent update (e.g. ErrorIrresolvableConflict).</summary>
        Conflict,
    }

    private sealed record PatchResult(PatchStatus Status, GraphMessage? Message = null);

    private async Task<PatchResult> PatchCategoriesAsync(string messageId, IReadOnlyList<string> categories, string? etag, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"{_mailboxPath}/{Uri.EscapeDataString(messageId)}")
        {
            Content = JsonContent.Create(new { categories }),
        };
        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        using var response = await http.SendAsync(request, ct);
        switch (response.StatusCode)
        {
            case HttpStatusCode.PreconditionFailed:
                return new PatchResult(PatchStatus.PreconditionFailed);
            case HttpStatusCode.Conflict:
                return new PatchResult(PatchStatus.Conflict);
        }

        await EnsureSuccessAsync(response, ct);

        // Graph documents 200 with the updated message, but the write has succeeded either way, so tolerate an
        // empty body (e.g. 204) by reporting the categories that were written.
        var body = await response.Content.ReadAsStringAsync(ct);
        var updated = string.IsNullOrWhiteSpace(body) ? null : JsonSerializer.Deserialize<GraphMessage>(body);
        return new PatchResult(PatchStatus.Updated, updated ?? new GraphMessage { Id = messageId, Categories = [.. categories] });
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        string? code = null, message = null;
        try
        {
            var envelope = await response.Content.ReadFromJsonAsync<GraphErrorEnvelope>(ct);
            code = envelope?.Error?.Code;
            message = envelope?.Error?.Message;
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException)
        {
            // Non-JSON or empty error body (e.g. from a proxy); fall through with status code only.
        }

        var requestId = response.Headers.TryGetValues("request-id", out var values) ? values.FirstOrDefault() : null;
        throw new GraphException(response.StatusCode, code, message, requestId);
    }

    private static bool IsUnknownMessage(GraphException ex)
        => ex.StatusCode == HttpStatusCode.NotFound
           || (ex.StatusCode == HttpStatusCode.BadRequest && ex.Code is not null && InvalidIdCodes.Contains(ex.Code));

    private CategoryOutcome MapGraphError(GraphException ex)
    {
        LogGraphError(ex.StatusCode, ex.Code, ex.GraphRequestId, ex.GraphMessage);
        var status = (int)ex.StatusCode;

        return ex switch
        {
            { StatusCode: HttpStatusCode.NotFound } => new CategoryOutcome(CategoryOutcomeStatus.MessageNotFound,
                Detail: "The message was not found in the shared mailbox. It may have been deleted or moved; " +
                        "pass 'internetMessageId' as well so a moved message can still be found.",
                GraphRequestId: ex.GraphRequestId),

            _ when IsUnknownMessage(ex) => new CategoryOutcome(CategoryOutcomeStatus.InvalidMessageId,
                Detail: "The messageId does not identify a message in the shared mailbox. Check the flow uses the " +
                        "trigger for the same mailbox, or pass 'internetMessageId' as well.",
                GraphRequestId: ex.GraphRequestId),

            { StatusCode: HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden } => new CategoryOutcome(CategoryOutcomeStatus.MailboxAccessDenied,
                Detail: "The function's identity is not permitted to modify this mailbox. Check the Exchange RBAC for Applications " +
                        "assignment (changes can take up to 2 hours to apply).",
                GraphRequestId: ex.GraphRequestId),

            // Throttling and server errors that outlasted our retries: transient, worth the caller retrying later.
            _ when ex.StatusCode == HttpStatusCode.TooManyRequests || status >= 500 => new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure,
                Detail: $"Microsoft Graph returned {status} {ex.Code}.", GraphRequestId: ex.GraphRequestId),

            // Any other 4xx is a permanent rejection; retrying would only repeat it.
            _ => new CategoryOutcome(CategoryOutcomeStatus.GraphRejected,
                Detail: $"Microsoft Graph rejected the request: {status} {ex.Code} {ex.GraphMessage}".TrimEnd(),
                GraphRequestId: ex.GraphRequestId),
        };
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Updated categories on message {MessageId} (mode {Mode}); it now has {Count} categories")]
    private partial void LogUpdated(string messageId, CategoryMode mode, int count);

    [LoggerMessage(Level = LogLevel.Information, Message = "Message {MessageId} already had the requested categories (mode {Mode}); no update made")]
    private partial void LogNoChange(string messageId, CategoryMode mode);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Message {MessageId} update returned {Result} (attempt {Attempt}); retrying")]
    private partial void LogConcurrencyRetry(string messageId, PatchStatus result, int attempt);

    [LoggerMessage(Level = LogLevel.Warning, Message = "If-Match was rejected for message {MessageId} although its ETag is unchanged; updating without If-Match")]
    private partial void LogIfMatchDisabled(string messageId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Message {MessageId} not found ({StatusCode} {Code}); looking it up by internetMessageId")]
    private partial void LogFallingBackToInternetMessageId(string messageId, HttpStatusCode statusCode, string? code);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Graph returned {StatusCode} {Code} (request-id {GraphRequestId}): {GraphMessage}")]
    private partial void LogGraphError(HttpStatusCode statusCode, string? code, string? graphRequestId, string? graphMessage);

    [LoggerMessage(Level = LogLevel.Error, Message = "Failed to acquire a Microsoft Graph token")]
    private partial void LogTokenFailure(Exception ex);

    [LoggerMessage(Level = LogLevel.Error, Message = "Microsoft Graph was unreachable after retries")]
    private partial void LogUpstreamUnavailable(Exception ex);

    [LoggerMessage(Level = LogLevel.Error, Message = "Unexpected error while updating message categories")]
    private partial void LogUnexpected(Exception ex);
}

internal sealed class GraphException(HttpStatusCode statusCode, string? code, string? message, string? requestId)
    : Exception($"Graph returned {(int)statusCode} {code}: {message}")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public string? Code { get; } = code;
    public string? GraphMessage { get; } = message;
    public string? GraphRequestId { get; } = requestId;
}
