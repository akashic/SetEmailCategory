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
    MailboxAccessDenied,
    UpstreamFailure,
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
    /// <summary>Attempts at a read-modify-write when another writer changes the message between our GET and PATCH.</summary>
    internal const int MaxConcurrencyAttempts = 3;

    private readonly string _mailboxPath = $"users/{Uri.EscapeDataString(options.Value.Address)}/messages";

    public async Task<CategoryOutcome> ApplyAsync(ValidatedRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var messageId = request.MessageId;
            if (messageId is null)
            {
                var lookup = await FindByInternetMessageIdAsync(request.InternetMessageId!, cancellationToken);
                if (lookup.Status != CategoryOutcomeStatus.Success)
                {
                    return lookup;
                }

                messageId = lookup.MessageId!;
            }

            return request.Mode == CategoryMode.Replace
                ? await ReplaceAsync(messageId, request.Categories, cancellationToken)
                : await MergeAsync(messageId, request, cancellationToken);
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
        catch (Exception ex) when (ex is HttpRequestException or TimeoutException
                                       or Polly.Timeout.TimeoutRejectedException
                                       or Polly.CircuitBreaker.BrokenCircuitException)
        {
            LogUpstreamUnavailable(ex);
            return new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure, Detail: "Microsoft Graph could not be reached.");
        }
    }

    private async Task<CategoryOutcome> ReplaceAsync(string messageId, IReadOnlyList<string> categories, CancellationToken ct)
    {
        // Without If-Match there is no 412, so a null (precondition failed) result is impossible here.
        var updated = await PatchCategoriesAsync(messageId, categories, etag: null, ct)
            ?? throw new InvalidOperationException("Unexpected 412 from an unconditional PATCH.");
        LogUpdated(messageId, CategoryMode.Replace, updated.Categories.Count);
        return new CategoryOutcome(CategoryOutcomeStatus.Success, updated.Id, updated.Categories, Changed: true);
    }

    private async Task<CategoryOutcome> MergeAsync(string messageId, ValidatedRequest request, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            var current = await GetMessageAsync(messageId, ct);
            var desired = Merge(current.Categories, request.Categories, request.Mode);

            if (desired.SequenceEqual(current.Categories, StringComparer.Ordinal))
            {
                LogNoChange(messageId, request.Mode);
                return new CategoryOutcome(CategoryOutcomeStatus.Success, current.Id, current.Categories, Changed: false);
            }

            // If-Match makes the read-modify-write safe against a concurrent flow run (or a user in Outlook)
            // changing categories between our GET and PATCH. Graph returns 412 in that case and we re-read.
            var updated = await PatchCategoriesAsync(messageId, desired, current.ETag, ct);
            if (updated is not null)
            {
                LogUpdated(messageId, request.Mode, updated.Categories.Count);
                return new CategoryOutcome(CategoryOutcomeStatus.Success, updated.Id, updated.Categories, Changed: true);
            }

            if (attempt >= MaxConcurrencyAttempts)
            {
                return new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure,
                    Detail: "The message kept changing while categories were being updated. Retry the request.");
            }

            LogConcurrencyRetry(messageId, attempt);
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

        return page?.Value.Count switch
        {
            1 => new CategoryOutcome(CategoryOutcomeStatus.Success, page.Value[0].Id),
            0 or null => new CategoryOutcome(CategoryOutcomeStatus.MessageNotFound,
                Detail: "No message with that internetMessageId exists in the shared mailbox."),
            _ => new CategoryOutcome(CategoryOutcomeStatus.AmbiguousMessage,
                Detail: "More than one message has that internetMessageId. Supply 'messageId' instead."),
        };
    }

    private async Task<GraphMessage> GetMessageAsync(string messageId, CancellationToken ct)
    {
        using var response = await http.GetAsync($"{_mailboxPath}/{Uri.EscapeDataString(messageId)}?$select=id,categories", ct);
        await EnsureSuccessAsync(response, ct);
        return (await response.Content.ReadFromJsonAsync<GraphMessage>(ct))!;
    }

    /// <summary>PATCHes the categories. Returns null only when <paramref name="etag"/> no longer matches (HTTP 412).</summary>
    private async Task<GraphMessage?> PatchCategoriesAsync(string messageId, IReadOnlyList<string> categories, string? etag, CancellationToken ct)
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
        if (response.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            return null;
        }

        await EnsureSuccessAsync(response, ct);

        // Graph documents 200 with the updated message, but the write has succeeded either way, so an empty
        // body (e.g. 204) must not be mistaken for the 412 "changed underneath us" case above.
        var body = await response.Content.ReadAsStringAsync(ct);
        var updated = string.IsNullOrWhiteSpace(body) ? null : JsonSerializer.Deserialize<GraphMessage>(body);
        return updated ?? new GraphMessage { Id = messageId, Categories = [.. categories] };
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
        catch (JsonException)
        {
            // Non-JSON error body (e.g. from a proxy); fall through with status code only.
        }

        var requestId = response.Headers.TryGetValues("request-id", out var values) ? values.FirstOrDefault() : null;
        throw new GraphException(response.StatusCode, code, message, requestId);
    }

    private CategoryOutcome MapGraphError(GraphException ex)
    {
        LogGraphError(ex.StatusCode, ex.Code, ex.GraphRequestId, ex.GraphMessage);

        return ex.StatusCode switch
        {
            HttpStatusCode.NotFound => new CategoryOutcome(CategoryOutcomeStatus.MessageNotFound,
                Detail: "The message was not found in the shared mailbox. It may have been deleted or moved; " +
                        "if it was moved, supply 'internetMessageId' instead.",
                GraphRequestId: ex.GraphRequestId),

            HttpStatusCode.BadRequest when ex.Code is "ErrorInvalidIdMalformed" or "ErrorInvalidId" =>
                new CategoryOutcome(CategoryOutcomeStatus.InvalidMessageId,
                    Detail: "The messageId is not a valid Outlook message ID.", GraphRequestId: ex.GraphRequestId),

            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new CategoryOutcome(CategoryOutcomeStatus.MailboxAccessDenied,
                Detail: "The function's identity is not permitted to modify this mailbox. Check the Exchange RBAC for Applications " +
                        "assignment (changes can take up to 2 hours to apply).",
                GraphRequestId: ex.GraphRequestId),

            _ => new CategoryOutcome(CategoryOutcomeStatus.UpstreamFailure,
                Detail: $"Microsoft Graph returned {(int)ex.StatusCode} {ex.Code}.", GraphRequestId: ex.GraphRequestId),
        };
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Updated categories on message {MessageId} (mode {Mode}); it now has {Count} categories")]
    private partial void LogUpdated(string messageId, CategoryMode mode, int count);

    [LoggerMessage(Level = LogLevel.Information, Message = "Message {MessageId} already had the requested categories (mode {Mode}); no update made")]
    private partial void LogNoChange(string messageId, CategoryMode mode);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Message {MessageId} changed during update (attempt {Attempt}); retrying")]
    private partial void LogConcurrencyRetry(string messageId, int attempt);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Graph returned {StatusCode} {Code} (request-id {GraphRequestId}): {GraphMessage}")]
    private partial void LogGraphError(HttpStatusCode statusCode, string? code, string? graphRequestId, string? graphMessage);

    [LoggerMessage(Level = LogLevel.Error, Message = "Failed to acquire a Microsoft Graph token")]
    private partial void LogTokenFailure(Exception ex);

    [LoggerMessage(Level = LogLevel.Error, Message = "Microsoft Graph was unreachable after retries")]
    private partial void LogUpstreamUnavailable(Exception ex);
}

internal sealed class GraphException(HttpStatusCode statusCode, string? code, string? message, string? requestId)
    : Exception($"Graph returned {(int)statusCode} {code}: {message}")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public string? Code { get; } = code;
    public string? GraphMessage { get; } = message;
    public string? GraphRequestId { get; } = requestId;
}
