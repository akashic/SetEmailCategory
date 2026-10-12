using Microsoft.Extensions.Options;

namespace SetEmailCategory.Graph;

/// <summary>Process-wide gate shared by every Graph request (handlers are recreated periodically; this is a singleton).</summary>
internal sealed class GraphConcurrencyLimiter(IOptions<ProcessingOptions> options) : IDisposable
{
    public SemaphoreSlim Semaphore { get; } = new(options.Value.MaxConcurrentGraphRequests, options.Value.MaxConcurrentGraphRequests);

    public void Dispose() => Semaphore.Dispose();
}

/// <summary>
/// Limits in-flight Graph requests per instance. Registered innermost (after retry and auth) so a slot is held only
/// while a request is actually on the wire, not during retry back-off.
/// </summary>
internal sealed class GraphConcurrencyHandler(GraphConcurrencyLimiter limiter) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await limiter.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            limiter.Semaphore.Release();
        }
    }
}
