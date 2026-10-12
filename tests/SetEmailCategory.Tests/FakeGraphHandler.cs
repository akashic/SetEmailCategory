using System.Net;
using System.Text;
using System.Text.Json;

namespace SetEmailCategory.Tests;

/// <summary>Records requests and replays scripted responses in order.</summary>
internal sealed class FakeGraphHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responses = new();

    public List<(HttpMethod Method, string PathAndQuery, string? Body, string? IfMatch)> Requests { get; } = [];

    public FakeGraphHandler Respond(HttpStatusCode status, object? body = null, string? requestId = null)
    {
        _responses.Enqueue(_ =>
        {
            var response = new HttpResponseMessage(status);
            if (body is not null)
            {
                response.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            }
            if (requestId is not null)
            {
                response.Headers.Add("request-id", requestId);
            }
            return response;
        });
        return this;
    }

    public FakeGraphHandler RespondMessage(string id, string[] categories, string etag = "W/\"etag-1\"")
        => Respond(HttpStatusCode.OK, new Dictionary<string, object> { ["id"] = id, ["categories"] = categories, ["@odata.etag"] = etag });

    public FakeGraphHandler RespondError(HttpStatusCode status, string code, string? requestId = null)
        => Respond(status, new { error = new { code, message = $"{code} message" } }, requestId);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        var ifMatch = request.Headers.TryGetValues("If-Match", out var values) ? values.Single() : null;
        Requests.Add((request.Method, request.RequestUri!.PathAndQuery, body, ifMatch));

        if (_responses.Count == 0)
        {
            throw new InvalidOperationException($"Unexpected request: {request.Method} {request.RequestUri}");
        }

        return _responses.Dequeue()(request);
    }
}
