using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

public class MailCategoryServiceTests
{
    private const string Mailbox = "shared@contoso.com";
    private const string MessagesPath = "/v1.0/users/shared%40contoso.com/messages";

    private readonly FakeGraphHandler _graph = new();

    private MailCategoryService CreateService() => new(
        new HttpClient(_graph) { BaseAddress = new Uri("https://graph.microsoft.com/v1.0/") },
        Options.Create(new SharedMailboxOptions { Address = Mailbox }),
        NullLogger<MailCategoryService>.Instance);

    private static ValidatedRequest Request(CategoryMode mode, params string[] categories)
        => new("msg-1", null, categories, mode);

    [Fact]
    public async Task Add_merges_with_existing_categories_using_if_match()
    {
        _graph.RespondMessage("msg-1", ["Existing"], etag: "W/\"v1\"")
              .RespondMessage("msg-1", ["Existing", "Invoice"]);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "Invoice"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.True(outcome.Changed);
        Assert.Equal(["Existing", "Invoice"], outcome.Categories);

        var (method, path, body, ifMatch) = _graph.Requests[1];
        Assert.Equal(HttpMethod.Patch, method);
        Assert.Equal($"{MessagesPath}/msg-1", path);
        Assert.Equal("""{"categories":["Existing","Invoice"]}""", body);
        Assert.Equal("W/\"v1\"", ifMatch);
    }

    [Fact]
    public async Task Add_is_a_no_op_when_category_already_present_with_different_casing()
    {
        _graph.RespondMessage("msg-1", ["INVOICE"]);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "Invoice"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.False(outcome.Changed);
        Assert.Single(_graph.Requests); // GET only, no PATCH
    }

    [Fact]
    public async Task Remove_removes_case_insensitively()
    {
        _graph.RespondMessage("msg-1", ["Invoice", "Urgent"])
              .RespondMessage("msg-1", ["Urgent"]);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Remove, "invoice"), default);

        Assert.Equal(["Urgent"], outcome.Categories);
        Assert.Equal("""{"categories":["Urgent"]}""", _graph.Requests[1].Body);
    }

    [Fact]
    public async Task Replace_patches_without_reading_first()
    {
        _graph.RespondMessage("msg-1", ["Only"]);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Replace, "Only"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        var request = Assert.Single(_graph.Requests);
        Assert.Equal(HttpMethod.Patch, request.Method);
        Assert.Null(request.IfMatch);
    }

    [Fact]
    public async Task Replace_tolerates_empty_patch_response()
    {
        _graph.Respond(HttpStatusCode.NoContent);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Replace, "Only"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("msg-1", outcome.MessageId);
        Assert.Equal(["Only"], outcome.Categories);
    }

    [Fact]
    public async Task Add_treats_empty_patch_response_as_success_not_as_a_conflict()
    {
        _graph.RespondMessage("msg-1", ["Existing"])
              .Respond(HttpStatusCode.NoContent);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "Invoice"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.True(outcome.Changed);
        Assert.Equal(["Existing", "Invoice"], outcome.Categories);
        Assert.Equal(2, _graph.Requests.Count); // GET + PATCH, no concurrency retry
    }

    [Fact]
    public async Task Retries_read_modify_write_when_message_changed_concurrently()
    {
        _graph.RespondMessage("msg-1", ["A"], etag: "W/\"v1\"")
              .Respond(HttpStatusCode.PreconditionFailed)
              .RespondMessage("msg-1", ["A", "B"], etag: "W/\"v2\"")
              .RespondMessage("msg-1", ["A", "B", "Invoice"]);

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "Invoice"), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal(["A", "B", "Invoice"], outcome.Categories);
        Assert.Equal("W/\"v2\"", _graph.Requests[3].IfMatch);
    }

    [Fact]
    public async Task Gives_up_after_max_concurrency_attempts()
    {
        for (var i = 0; i < MailCategoryService.MaxConcurrencyAttempts; i++)
        {
            _graph.RespondMessage("msg-1", [$"v{i}"]).Respond(HttpStatusCode.PreconditionFailed);
        }

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "Invoice"), default);

        Assert.Equal(CategoryOutcomeStatus.UpstreamFailure, outcome.Status);
        Assert.Equal(MailCategoryService.MaxConcurrencyAttempts * 2, _graph.Requests.Count);
    }

    [Fact]
    public async Task Looks_up_by_internet_message_id_with_escaped_filter()
    {
        _graph.Respond(HttpStatusCode.OK, new { value = new[] { new { id = "found-id" } } })
              .RespondMessage("found-id", [])
              .RespondMessage("found-id", ["Invoice"]);

        var request = new ValidatedRequest(null, "<a'b@contoso.com>", ["Invoice"], CategoryMode.Add);
        var outcome = await CreateService().ApplyAsync(request, default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("found-id", outcome.MessageId);
        var lookup = Uri.UnescapeDataString(_graph.Requests[0].PathAndQuery);
        Assert.Contains("$filter=internetMessageId eq '<a''b@contoso.com>'", lookup);
        Assert.Equal($"{MessagesPath}/found-id?$select=id,categories", _graph.Requests[1].PathAndQuery);
    }

    [Theory]
    [InlineData(0, CategoryOutcomeStatus.MessageNotFound)]
    [InlineData(2, CategoryOutcomeStatus.AmbiguousMessage)]
    public async Task Internet_message_id_lookup_requires_exactly_one_match(int matches, CategoryOutcomeStatus expected)
    {
        _graph.Respond(HttpStatusCode.OK, new { value = Enumerable.Range(0, matches).Select(i => new { id = $"id-{i}" }) });

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest(null, "<x@y>", ["A"], CategoryMode.Add), default);

        Assert.Equal(expected, outcome.Status);
        Assert.Single(_graph.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, "ErrorItemNotFound", CategoryOutcomeStatus.MessageNotFound)]
    [InlineData(HttpStatusCode.BadRequest, "ErrorInvalidIdMalformed", CategoryOutcomeStatus.InvalidMessageId)]
    [InlineData(HttpStatusCode.Forbidden, "ErrorAccessDenied", CategoryOutcomeStatus.MailboxAccessDenied)]
    [InlineData(HttpStatusCode.InternalServerError, "ErrorInternalServerError", CategoryOutcomeStatus.UpstreamFailure)]
    public async Task Maps_graph_errors_and_surfaces_request_id(HttpStatusCode status, string code, CategoryOutcomeStatus expected)
    {
        _graph.RespondError(status, code, requestId: "req-123");

        var outcome = await CreateService().ApplyAsync(Request(CategoryMode.Add, "A"), default);

        Assert.Equal(expected, outcome.Status);
        Assert.Equal("req-123", outcome.GraphRequestId);
    }

    [Fact]
    public async Task Escapes_message_id_in_path()
    {
        _graph.RespondMessage("a/b=", ["X"]);

        await CreateService().ApplyAsync(new ValidatedRequest("a/b=", null, ["X"], CategoryMode.Replace), default);

        Assert.Equal($"{MessagesPath}/a%2Fb%3D", _graph.Requests[0].PathAndQuery);
    }

    [Theory]
    [InlineData(new[] { "A", "B" }, new[] { "b", "C" }, CategoryMode.Add, new[] { "A", "B", "C" })]
    [InlineData(new[] { "A", "B" }, new[] { "a" }, CategoryMode.Remove, new[] { "B" })]
    [InlineData(new[] { "A" }, new[] { "X", "Y" }, CategoryMode.Replace, new[] { "X", "Y" })]
    public void Merge_computes_expected_list(string[] existing, string[] requested, CategoryMode mode, string[] expected)
        => Assert.Equal(expected, MailCategoryService.Merge(existing, requested, mode));
}
