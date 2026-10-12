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

    private static SetCategoryFunction CreateFunction(IMailCategoryService service, bool requireAuth = true) => new(
        service,
        Options.Create(new SecurityOptions { RequireAuthenticatedCaller = requireAuth }),
        NullLogger<SetCategoryFunction>.Instance);

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
    [InlineData(CategoryOutcomeStatus.MailboxAccessDenied, 502)]
    [InlineData(CategoryOutcomeStatus.UpstreamFailure, 503)]
    public async Task Maps_outcomes_to_status_codes(CategoryOutcomeStatus status, int expected)
    {
        var service = new StubService(new CategoryOutcome(status, Detail: "d", GraphRequestId: "req-1"));
        var result = await CreateFunction(service).Run(CreateRequest("""{"messageId":"m","categories":["A"]}"""), default);

        var problem = Assert.IsType<ObjectResult>(result);
        Assert.Equal(expected, problem.StatusCode);
        Assert.Equal("req-1", Assert.IsType<ProblemDetails>(problem.Value).Extensions["graphRequestId"]);
    }
}
