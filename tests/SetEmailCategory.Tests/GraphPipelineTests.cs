using System.Net;
using Azure.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

/// <summary>Exercises the real handler pipeline from <see cref="GraphClientRegistration"/> with only the network faked.</summary>
public class GraphPipelineTests
{
    private sealed class StaticTokenCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
            => new("test-token", DateTimeOffset.UtcNow.AddHours(1));

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
            => ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class RecordingHandler(FakeGraphHandler inner) : DelegatingHandler(inner)
    {
        public List<string?> AuthHeaders { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            AuthHeaders.Add(request.Headers.Authorization?.ToString());
            return base.SendAsync(request, cancellationToken);
        }
    }

    [Fact]
    public async Task Retries_graph_throttling_through_the_real_pipeline_with_auth_on_every_attempt()
    {
        var fake = new FakeGraphHandler();
        fake.RespondError(HttpStatusCode.TooManyRequests, "ApplicationThrottled")
            .RespondMessage("msg-1", ["Only"]);
        var recorder = new RecordingHandler(fake);

        var services = new ServiceCollection();
        services.AddLogging(b => b.SetMinimumLevel(LogLevel.Warning));
        services.AddSingleton<TokenCredential>(new StaticTokenCredential());
        services.AddOptions<SharedMailboxOptions>().Configure(o => o.Address = "shared@contoso.com");
        services.AddOptions<ProcessingOptions>();
        services.AddGraphClient().ConfigurePrimaryHttpMessageHandler(() => recorder);

        await using var provider = services.BuildServiceProvider();
        var service = provider.GetRequiredService<IMailCategoryService>();

        var outcome = await service.ApplyAsync(new ValidatedRequest("msg-1", null, ["Only"], CategoryMode.Replace), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal(2, fake.Requests.Count); // 429 then success: retried by the resilience handler
        Assert.All(recorder.AuthHeaders, h => Assert.Equal("Bearer test-token", h));
    }
}
