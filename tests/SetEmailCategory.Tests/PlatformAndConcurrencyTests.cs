using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using SetEmailCategory.Functions;
using SetEmailCategory.Graph;

namespace SetEmailCategory.Tests;

public class PlatformInfoTests
{
    private static PlatformInfo From(params (string Name, string Value)[] vars)
    {
        var map = vars.ToDictionary(v => v.Name, v => v.Value);
        return PlatformInfo.FromVariables(name => map.GetValueOrDefault(name));
    }

    [Fact]
    public void Local_development_is_not_azure()
        => Assert.False(From().RunningInAzure);

    [Theory]
    [InlineData("WEBSITE_INSTANCE_ID")]
    [InlineData("CONTAINER_NAME")]
    [InlineData("WEBSITE_SKU")]
    public void Any_host_marker_means_azure(string marker)
        => Assert.True(From((marker, "x")).RunningInAzure);

    [Theory]
    [InlineData("True", true)]
    [InlineData("true", true)]
    [InlineData("False", false)]
    [InlineData("", false)]
    public void Reads_easy_auth_flag(string value, bool expected)
        => Assert.Equal(expected, From(("WEBSITE_AUTH_ENABLED", value)).EasyAuthEnabled);

    [Theory]
    [InlineData(true, false, true, true)]   // Azure, auth off, check on -> refuse
    [InlineData(true, true, true, false)]   // Azure, auth on
    [InlineData(false, false, true, false)] // local
    [InlineData(true, false, false, false)] // check explicitly disabled
    public void Refuses_requests_only_when_check_applies(bool azure, bool easyAuth, bool required, bool refuses)
        => Assert.Equal(refuses, new PlatformInfo(azure, easyAuth).RefusesRequests(new SecurityOptions { RequireEasyAuthEnabled = required }));
}

public class HealthFunctionTests
{
    [Theory]
    [InlineData(true, true, true)]
    [InlineData(true, false, false)]
    public void Reports_platform_detection_and_readiness(bool azure, bool easyAuth, bool accepting)
    {
        var function = new HealthFunction(new PlatformInfo(azure, easyAuth), Options.Create(new SecurityOptions()));

        var body = Assert.IsType<HealthResponse>(Assert.IsType<OkObjectResult>(function.Run(new DefaultHttpContext().Request)).Value);

        Assert.Equal(azure, body.RunningInAzure);
        Assert.Equal(accepting, body.AcceptingRequests);
    }
}

public class GraphConcurrencyHandlerTests
{
    private sealed class SlowCountingHandler : HttpMessageHandler
    {
        private int _inFlight;
        public int MaxObserved;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var now = Interlocked.Increment(ref _inFlight);
            InterlockedMax(ref MaxObserved, now);
            await Task.Delay(30, cancellationToken);
            Interlocked.Decrement(ref _inFlight);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK);
        }

        private static void InterlockedMax(ref int target, int value)
        {
            int current;
            while ((current = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, current) != current) { }
        }
    }

    [Fact]
    public async Task Limits_concurrent_graph_requests_per_instance()
    {
        var inner = new SlowCountingHandler();
        using var limiter = new GraphConcurrencyLimiter(Options.Create(new ProcessingOptions { MaxConcurrentGraphRequests = 2 }));
        using var client = new HttpClient(new GraphConcurrencyHandler(limiter) { InnerHandler = inner });

        await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => client.GetAsync("https://graph.example/x")));

        Assert.Equal(2, inner.MaxObserved);
    }
}
