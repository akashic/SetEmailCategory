using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

/// <summary>Failure modes seen when the function is driven by a Power Automate shared-mailbox trigger.</summary>
public class MailCategoryServiceResilienceTests
{
    private readonly FakeGraphHandler _graph = new();

    private MailCategoryService CreateService() => new(
        new HttpClient(_graph) { BaseAddress = new Uri("https://graph.microsoft.com/v1.0/") },
        Options.Create(new SharedMailboxOptions { Address = "shared@contoso.com" }),
        NullLogger<MailCategoryService>.Instance);

    private static object Page(params string[] ids) => new { value = ids.Select(id => new { id }) };

    // ---------- Moved message: fall back from messageId to internetMessageId ----------

    [Fact]
    public async Task Falls_back_to_internet_message_id_when_message_was_moved()
    {
        _graph.RespondError(HttpStatusCode.NotFound, "ErrorItemNotFound")   // GET old-id
              .Respond(HttpStatusCode.OK, Page("new-id"))                  // lookup
              .RespondMessage("new-id", ["Existing"])                      // GET new-id
              .RespondMessage("new-id", ["Existing", "Invoice"]);          // PATCH

        var outcome = await CreateService().ApplyAsync(
            new ValidatedRequest("old-id", "<a@contoso.com>", ["Invoice"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("new-id", outcome.MessageId);
        Assert.Contains("filter", _graph.Requests[1].PathAndQuery);
        Assert.EndsWith("/messages/new-id", _graph.Requests[3].PathAndQuery);
    }

    [Fact]
    public async Task Falls_back_when_message_id_format_is_rejected()
    {
        _graph.RespondError(HttpStatusCode.BadRequest, "ErrorInvalidIdMalformed") // PATCH bad-id
              .Respond(HttpStatusCode.OK, Page("good-id"))
              .RespondMessage("good-id", ["Only"]);

        var outcome = await CreateService().ApplyAsync(
            new ValidatedRequest("bad-id", "<a@contoso.com>", ["Only"], CategoryMode.Replace), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("good-id", outcome.MessageId);
    }

    [Fact]
    public async Task Fallback_reports_not_found_when_lookup_finds_nothing()
    {
        _graph.RespondError(HttpStatusCode.NotFound, "ErrorItemNotFound")
              .Respond(HttpStatusCode.OK, Page());

        var outcome = await CreateService().ApplyAsync(
            new ValidatedRequest("old-id", "<a@contoso.com>", ["A"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.MessageNotFound, outcome.Status);
    }

    [Fact]
    public async Task Does_not_fall_back_for_errors_unrelated_to_the_id()
    {
        _graph.RespondError(HttpStatusCode.Forbidden, "ErrorAccessDenied");

        var outcome = await CreateService().ApplyAsync(
            new ValidatedRequest("id", "<a@contoso.com>", ["A"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.MailboxAccessDenied, outcome.Status);
        Assert.Single(_graph.Requests);
    }

    // ---------- Concurrency: 412 / 409 ----------

    [Fact]
    public async Task Stops_sending_if_match_when_412_recurs_with_an_unchanged_etag()
    {
        _graph.RespondMessage("msg-1", ["A"], etag: "W/\"same\"")
              .Respond(HttpStatusCode.PreconditionFailed)
              .RespondMessage("msg-1", ["A"], etag: "W/\"same\"")
              .RespondMessage("msg-1", ["A", "Invoice"]);

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["Invoice"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("W/\"same\"", _graph.Requests[1].IfMatch);
        Assert.Null(_graph.Requests[3].IfMatch);
    }

    [Fact]
    public async Task Retries_replace_after_409_conflict()
    {
        _graph.RespondError(HttpStatusCode.Conflict, "ErrorIrresolvableConflict")
              .RespondMessage("msg-1", ["Only"]);

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["Only"], CategoryMode.Replace), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal(2, _graph.Requests.Count);
    }

    [Fact]
    public async Task Retries_add_after_409_conflict_and_keeps_if_match()
    {
        _graph.RespondMessage("msg-1", ["A"], etag: "W/\"v1\"")
              .RespondError(HttpStatusCode.Conflict, "ErrorIrresolvableConflict")
              .RespondMessage("msg-1", ["A"], etag: "W/\"v1\"")
              .RespondMessage("msg-1", ["A", "B"]);

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["B"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("W/\"v1\"", _graph.Requests[3].IfMatch); // a 409 says nothing about If-Match support
    }

    // ---------- Defensive parsing / unexpected failures ----------

    [Fact]
    public async Task Treats_null_categories_from_graph_as_empty()
    {
        _graph.RespondRaw(HttpStatusCode.OK, """{"id":"msg-1","categories":null,"@odata.etag":"W/\"x\""}""")
              .RespondMessage("msg-1", ["A"]);

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["A"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal("""{"categories":["A"]}""", _graph.Requests[1].Body);
    }

    [Fact]
    public async Task Malformed_success_response_returns_unexpected_error_instead_of_throwing()
    {
        _graph.RespondRaw(HttpStatusCode.OK, "<html>proxy page</html>", "text/html");

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["A"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.UnexpectedError, outcome.Status);
    }

    [Fact]
    public async Task Non_json_error_body_still_maps_by_status()
    {
        _graph.RespondRaw(HttpStatusCode.ServiceUnavailable, "", "text/plain");

        var outcome = await CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["A"], CategoryMode.Add), default);

        Assert.Equal(CategoryOutcomeStatus.UpstreamFailure, outcome.Status);
    }

    [Fact]
    public async Task Cancellation_propagates_so_the_function_can_apply_its_deadline()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateService().ApplyAsync(new ValidatedRequest("msg-1", null, ["A"], CategoryMode.Add), cts.Token));
    }
}
