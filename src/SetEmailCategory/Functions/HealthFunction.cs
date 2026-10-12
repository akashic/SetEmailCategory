using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Options;

namespace SetEmailCategory.Functions;

/// <summary>
/// Liveness/readiness probe used by the deployment pipeline's smoke test. Excluded from App Service Authentication
/// (see excludedPaths in infra/modules/functionApp.bicep). Reports only the build version and two booleans, so the
/// pipeline can prove the platform detection and the fail-closed Easy Auth check behave as intended after deployment.
/// </summary>
public sealed class HealthFunction(PlatformInfo platform, IOptions<SecurityOptions> security)
{
    private static readonly string Version =
        typeof(HealthFunction).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

    [Function("Health")]
    public IActionResult Run([HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequest req)
        => new OkObjectResult(new HealthResponse(
            Status: "ok",
            Version: Version,
            RunningInAzure: platform.RunningInAzure,
            AcceptingRequests: !platform.RefusesRequests(security.Value)));
}

public sealed record HealthResponse(string Status, string Version, bool RunningInAzure, bool AcceptingRequests);
