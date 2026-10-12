using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;

namespace SetEmailCategory.Functions;

/// <summary>
/// Liveness probe used by the deployment pipeline's smoke test. Excluded from App Service Authentication
/// (see excludedPaths in infra/modules/functionApp.bicep) and deliberately reveals nothing about configuration.
/// </summary>
public sealed class HealthFunction
{
    private static readonly string Version =
        typeof(HealthFunction).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

    [Function("Health")]
    public static IActionResult Run([HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequest req)
        => new OkObjectResult(new { status = "ok", version = Version });
}
