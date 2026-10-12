using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace SetEmailCategory.Graph;

public static class GraphClientRegistration
{
    /// <summary>
    /// Registers the typed Graph client used by <see cref="MailCategoryService"/>. Requires a singleton
    /// <see cref="Azure.Core.TokenCredential"/> and the SharedMailbox/Processing options to be registered.
    /// </summary>
    public static IHttpClientBuilder AddGraphClient(this IServiceCollection services)
    {
        services.AddSingleton<GraphConcurrencyLimiter>();
        services.AddTransient<GraphAuthHandler>();
        services.AddTransient<GraphConcurrencyHandler>();

        var graphClient = services.AddHttpClient<IMailCategoryService, MailCategoryService>((sp, http) =>
        {
            http.BaseAddress = sp.GetRequiredService<IOptions<SharedMailboxOptions>>().Value.GraphBaseUri;
            // Timeouts are owned by the resilience pipeline and the per-invocation deadline.
            http.Timeout = Timeout.InfiniteTimeSpan;
        });

        // Handler order (outermost first): resilience -> auth -> concurrency gate -> network.
        // Retry + timeouts only. No circuit breaker: Graph's Retry-After already says when to come back, and a breaker
        // would turn a burst of 429s into fast-failed requests.
        graphClient.AddResilienceHandler("graph", pipeline =>
        {
            pipeline.AddTimeout(TimeSpan.FromSeconds(60)); // total per Graph call, including retries
            pipeline.AddRetry(new HttpRetryStrategyOptions
            {
                // Defaults handle 408, 429, 5xx, HttpRequestException and attempt timeouts, honouring Retry-After.
                MaxRetryAttempts = 4,
                BackoffType = DelayBackoffType.Exponential,
                UseJitter = true,
                Delay = TimeSpan.FromSeconds(1),
            });
            pipeline.AddTimeout(TimeSpan.FromSeconds(15)); // per attempt
        });
        graphClient.AddHttpMessageHandler<GraphAuthHandler>();
        graphClient.AddHttpMessageHandler<GraphConcurrencyHandler>();

        return graphClient;
    }
}
