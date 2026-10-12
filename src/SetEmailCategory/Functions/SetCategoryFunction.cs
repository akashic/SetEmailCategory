using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Functions;

public sealed partial class SetCategoryFunction(
    IMailCategoryService service,
    IOptions<SecurityOptions> security,
    PlatformInfo platform,
    ILogger<SetCategoryFunction> logger)
{
    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // Injected by App Service Authentication (Easy Auth) after it validates the bearer token.
    // The platform strips these headers from inbound client requests, so they cannot be spoofed.
    internal const string PrincipalIdHeader = "X-MS-CLIENT-PRINCIPAL-ID";
    internal const string PrincipalNameHeader = "X-MS-CLIENT-PRINCIPAL-NAME";
    internal const string CorrelationHeader = "x-correlation-id";

    // Authentication is enforced by Easy Auth in front of the function, so the trigger is Anonymous
    // (a function key would be a second, shared secret for the custom connector to manage).
    [Function("SetCategory")]
    public async Task<IActionResult> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "messages/categories")] HttpRequest req,
        CancellationToken cancellationToken)
    {
        var callerId = req.Headers[PrincipalIdHeader].ToString();
        var callerName = req.Headers[PrincipalNameHeader].ToString();
        var correlationId = req.Headers[CorrelationHeader].ToString();

        using var scope = logger.BeginScope(new Dictionary<string, object?>
        {
            ["CallerId"] = callerId,
            ["CallerName"] = callerName,
            ["CorrelationId"] = correlationId,
        });

        // Fail closed: if Easy Auth has been switched off, the principal header below could be forged.
        // 500 rather than 503 so callers' retry policies don't keep hammering a misconfiguration.
        if (platform.RunningInAzure && security.Value.RequireEasyAuthEnabled && !platform.EasyAuthEnabled)
        {
            LogEasyAuthDisabled();
            return Problem(StatusCodes.Status500InternalServerError, "Service misconfigured",
                "App Service Authentication is not enabled on this function app, so requests are refused.");
        }

        if (security.Value.RequireAuthenticatedCaller && string.IsNullOrEmpty(callerId))
        {
            LogUnauthenticated();
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "An authenticated caller is required.");
        }

        SetCategoryRequest? body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<SetCategoryRequest>(req.Body, JsonOptions, cancellationToken);
        }
        catch (JsonException ex)
        {
            return Problem(StatusCodes.Status400BadRequest, "Invalid JSON", ex.Message);
        }

        var validated = RequestValidator.Validate(body, out var errors);
        if (validated is null)
        {
            return Problem(StatusCodes.Status400BadRequest, "Invalid request", string.Join(" ", errors));
        }

        var outcome = await service.ApplyAsync(validated, cancellationToken);

        return outcome.Status switch
        {
            CategoryOutcomeStatus.Success => new OkObjectResult(
                new SetCategoryResponse(outcome.MessageId!, outcome.Categories!, outcome.Changed)),
            CategoryOutcomeStatus.MessageNotFound => Problem(StatusCodes.Status404NotFound, "Message not found", outcome.Detail, outcome.GraphRequestId),
            CategoryOutcomeStatus.AmbiguousMessage => Problem(StatusCodes.Status409Conflict, "Ambiguous message", outcome.Detail, outcome.GraphRequestId),
            CategoryOutcomeStatus.InvalidMessageId => Problem(StatusCodes.Status400BadRequest, "Invalid message ID", outcome.Detail, outcome.GraphRequestId),
            // The caller is fine; our own identity lacks access. 502 tells Power Automate it's a server-side fault.
            CategoryOutcomeStatus.MailboxAccessDenied => Problem(StatusCodes.Status502BadGateway, "Mailbox access denied", outcome.Detail, outcome.GraphRequestId),
            _ => Problem(StatusCodes.Status503ServiceUnavailable, "Upstream failure", outcome.Detail, outcome.GraphRequestId),
        };
    }

    private static ObjectResult Problem(int status, string title, string? detail, string? graphRequestId = null)
    {
        var problem = new ProblemDetails { Status = status, Title = title, Detail = detail };
        if (graphRequestId is not null)
        {
            problem.Extensions["graphRequestId"] = graphRequestId;
        }

        return new ObjectResult(problem)
        {
            StatusCode = status,
            ContentTypes = { "application/problem+json" },
        };
    }

    [LoggerMessage(Level = LogLevel.Critical, Message = "Refused request: App Service Authentication (Easy Auth) is not enabled. Redeploy the Bicep template to restore authsettingsV2")]
    private partial void LogEasyAuthDisabled();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Rejected request with no authenticated principal; check that App Service Authentication is enabled")]
    private partial void LogUnauthenticated();
}
