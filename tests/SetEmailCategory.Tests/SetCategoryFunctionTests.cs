using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SetEmailCategory.Functions;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

public class SetCategoryFunctionTests
{
    private sealed class StubService(CategoryOutcome outcome) : IMailCategoryService
    {
        public ValidatedRequest? Received { get; private set; }

        public Task<CategoryOutcome> ApplyAsync(ValidatedRequest request, CancellationToken cancellationToken)
        {
            Received = request;
            return Task.FromResult(outcome);
        }
    }

    private static HttpRequest CreateRequest(string body, string? principalId = "caller-oid")
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        if (principalId is not null)
        {
            context.Request.Headers[SetCategoryFunction.PrincipalIdHeader] = principalId;
        }
        return context.Request;
    }

    private static SetCategoryFunction CreateFunction(
        IMailCategoryService service,
        bool requireAuth = true,
        PlatformInfo? platform = null,
        bool requireEasyAuthEnabled = true,
        int deadlineSeconds = 90) => new(
        service,
        Options.Create(new SecurityOptions { RequireAuthenticatedCaller = requireAuth, RequireEasyAuthEnabled = requireEasyAuthEnabled }),
        Options.Create(new ProcessingOptions { DeadlineSeconds = deadlineSeconds }),
        platform ?? new PlatformInfo(RunningInAzure: true, EasyAuthEnabled: true),
        NullLogger<SetCategoryFunction>.Instance);

    private const string ValidBody = """{"messageId":"m","categories":["A"]}""";

    private sealed class HangingService : IMailCategoryService
    {
        public async Task<CategoryOutcome> ApplyAsync(ValidatedRequest request, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }
    }

    [Fact]
    public async Task Returns_503_when_the_deadline_expires_instead_of_hanging_past_power_automates_timeout()
    {
        var result = await CreateFunction(new HangingService(), deadlineSeconds: 1).Run(CreateRequest(ValidBody), default);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, problem.StatusCode);
        Assert.Equal("Timed out", Assert.IsType<ProblemDetails>(problem.Value).Title);
    }

    [Fact]
    public async Task Fails_closed_in_azure_when_easy_auth_is_disabled()
    {
        var service = new StubService(Ok);
        var function = CreateFunction(service, platform: new PlatformInfo(RunningInAzure: true, EasyAuthEnabled: false));

        // Even a request carrying a (potentially forged) principal header is refused.
        var result = await function.Run(CreateRequest(ValidBody), default);

        Assert.Equal(StatusCodes.Status500InternalServerError, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Null(service.Received);
    }

    [Theory]
    [InlineData(true, true, true)]    // Azure, Easy Auth on
    [InlineData(false, false, true)]  // local development: check doesn't apply
    [InlineData(true, false, false)]  // Azure, Easy Auth off, check explicitly disabled by ops
    public async Task Easy_auth_check_allows_request(bool runningInAzure, bool easyAuthEnabled, bool requireEasyAuthEnabled)
    {
        var function = CreateFunction(new StubService(Ok),
            platform: new PlatformInfo(runningInAzure, easyAuthEnabled),
            requireEasyAuthEnabled: requireEasyAuthEnabled);

        Assert.IsType<OkObjectResult>(await function.Run(CreateRequest(ValidBody), default));
    }

    private static readonly CategoryOutcome Ok = new(CategoryOutcomeStatus.Success, "msg-1", ["Invoice"], Changed: true);

    [Fact]
    public async Task Rejects_request_without_easy_auth_principal()
    {
        var service = new StubService(Ok);
        var result = await CreateFunction(service).Run(CreateRequest("""{"messageId":"m","categories":["A"]}""", principalId: null), default);

        Assert.Equal(StatusCodes.Status401Unauthorized, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Null(service.Received);
    }

    [Fact]
    public async Task Allows_missing_principal_when_auth_check_disabled_for_local_dev()
    {
        var result = await CreateFunction(new StubService(Ok), requireAuth: false)
            .Run(CreateRequest("""{"messageId":"m","categories":["A"]}""", principalId: null), default);

        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task Parses_mode_case_insensitively_and_returns_result()
    {
        var service = new StubService(Ok);
        var result = await CreateFunction(service).Run(CreateRequest("""{"messageId":"m","categories":["A"],"mode":"REMOVE"}"""), default);

        var response = Assert.IsType<SetCategoryResponse>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal("msg-1", response.MessageId);
        Assert.Equal(["Invoice"], response.Categories);
        Assert.True(response.Changed);
        Assert.Equal(CategoryMode.Remove, service.Received!.Mode);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"messageId":"m","categories":[]}""")]
    [InlineData("""{"messageId":"m","categories":["A"],"mode":"bogus"}""")]
    public async Task Bad_input_returns_400_problem(string body)
    {
        var result = await CreateFunction(new StubService(Ok)).Run(CreateRequest(body), default);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, problem.StatusCode);
        Assert.IsType<ProblemDetails>(problem.Value);
    }

    [Theory]
    [InlineData(CategoryOutcomeStatus.MessageNotFound, 404)]
    [InlineData(CategoryOutcomeStatus.AmbiguousMessage, 409)]
    [InlineData(CategoryOutcomeStatus.InvalidMessageId, 400)]
    [InlineData(CategoryOutcomeStatus.GraphRejected, 400)]
    [InlineData(CategoryOutcomeStatus.MailboxAccessDenied, 502)]
    [InlineData(CategoryOutcomeStatus.UpstreamFailure, 503)]
    [InlineData(CategoryOutcomeStatus.UnexpectedError, 500)]
    public async Task Maps_outcomes_to_status_codes(CategoryOutcomeStatus status, int expected)
    {
        var service = new StubService(new CategoryOutcome(status, Detail: "d", GraphRequestId: "req-1"));
        var result = await CreateFunction(service).Run(CreateRequest("""{"messageId":"m","categories":["A"]}"""), default);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(expected, problem.StatusCode);
        Assert.Equal("req-1", Assert.IsType<ProblemDetails>(problem.Value).Extensions["graphRequestId"]);
    }

    [Theory]
    [InlineData("99")]
    [InlineData("1")]
    [InlineData("\"1\"")]
    [InlineData("\"replace, remove\"")]
    [InlineData("\"delete\"")]
    public async Task Rejects_modes_that_are_not_one_of_the_three_names(string mode)
    {
        var service = new StubService(Ok);

        var result = await CreateFunction(service).Run(CreateRequest($$"""{"messageId":"m","categories":["A"],"mode":{{mode}}}"""), default);

        Assert.Equal(StatusCodes.Status400BadRequest, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Null(service.Received);
    }

    [Theory]
    [InlineData("add", CategoryMode.Add)]
    [InlineData("Replace", CategoryMode.Replace)]
    [InlineData("REMOVE", CategoryMode.Remove)]
    public async Task Accepts_mode_names_in_any_case(string mode, CategoryMode expected)
    {
        var service = new StubService(Ok);

        await CreateFunction(service).Run(CreateRequest($$"""{"messageId":"m","categories":["A"],"mode":"{{mode}}"}"""), default);

        Assert.Equal(expected, service.Received!.Mode);
    }

    [Fact]
    public async Task Rejects_a_declared_content_length_over_the_limit_without_reading_the_body()
    {
        var service = new StubService(Ok);
        var request = CreateRequest(ValidBody);
        request.ContentLength = SetCategoryFunction.MaxBodyBytes + 1;

        var result = await CreateFunction(service).Run(request, default);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Equal(0, request.Body.Position);
        Assert.Null(service.Received);
    }

    [Fact]
    public async Task Rejects_an_oversized_body_without_content_length()
    {
        var service = new StubService(Ok);
        var padding = new string(' ', SetCategoryFunction.MaxBodyBytes);

        var result = await CreateFunction(service).Run(CreateRequest(ValidBody + padding), default);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Null(service.Received);
    }

    [Fact]
    public async Task Accepts_a_body_exactly_at_the_limit()
    {
        var service = new StubService(Ok);
        var padding = new string(' ', SetCategoryFunction.MaxBodyBytes - ValidBody.Length);

        var result = await CreateFunction(service).Run(CreateRequest(ValidBody + padding), default);

        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task Empty_body_is_a_400()
    {
        var result = await CreateFunction(new StubService(Ok)).Run(CreateRequest(""), default);

        Assert.Equal(StatusCodes.Status400BadRequest, Assert.IsType<ObjectResult>(result).StatusCode);
    }
}
