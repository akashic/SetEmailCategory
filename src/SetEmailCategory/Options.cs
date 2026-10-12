using System.ComponentModel.DataAnnotations;

namespace SetEmailCategory;

/// <summary>Bound from the "SharedMailbox" configuration section (app setting <c>SharedMailbox__Address</c>).</summary>
public sealed class SharedMailboxOptions : IValidatableObject
{
    public const string SectionName = "SharedMailbox";

    /// <summary>SMTP address (or Entra object ID) of the shared mailbox this app is allowed to modify.</summary>
    [Required]
    public string Address { get; set; } = string.Empty;

    /// <summary>Microsoft Graph base URL. Override only for national clouds; the token scope is derived from it.</summary>
    [Required]
    [Url]
    public string GraphBaseUrl { get; set; } = "https://graph.microsoft.com/v1.0/";

    /// <summary>
    /// <see cref="GraphBaseUrl"/> with a trailing slash. Without it, relative paths replace the last segment
    /// ("…/v1.0" + "users/x" resolves to "…/users/x"), silently dropping the API version.
    /// </summary>
    internal Uri GraphBaseUri => new(GraphBaseUrl.EndsWith('/') ? GraphBaseUrl : GraphBaseUrl + "/");

    /// <summary>
    /// Token scope for the Graph cloud named by <see cref="GraphBaseUrl"/> (e.g. https://graph.microsoft.us/.default),
    /// so changing the URL for a national cloud can't leave tokens issued for the wrong resource.
    /// </summary>
    internal string GraphTokenScope => $"{GraphBaseUri.GetLeftPart(UriPartial.Authority)}/.default";

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (!Uri.TryCreate(GraphBaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            yield return new ValidationResult("GraphBaseUrl must be an absolute https URL.", [nameof(GraphBaseUrl)]);
        }
    }
}

/// <summary>Bound from the "Security" configuration section.</summary>
public sealed class SecurityOptions
{
    public const string SectionName = "Security";

    /// <summary>
    /// When true (the default), requests without an App Service Authentication (Easy Auth) principal are rejected.
    /// This is defence in depth: Easy Auth should already have rejected them. Set to false only for local development.
    /// </summary>
    public bool RequireAuthenticatedCaller { get; set; } = true;

    /// <summary>
    /// When true (the default), the function refuses every request in Azure unless App Service Authentication is
    /// enabled. Without Easy Auth the platform no longer strips X-MS-CLIENT-PRINCIPAL-* headers, so a caller could
    /// forge the principal that <see cref="RequireAuthenticatedCaller"/> checks for. Ignored when running locally.
    /// </summary>
    public bool RequireEasyAuthEnabled { get; set; } = true;
}

/// <summary>Bound from the "Processing" configuration section.</summary>
public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    /// <summary>
    /// Overall time budget for one invocation, including Graph retries. Must stay below Power Automate's 120-second
    /// limit for synchronous connector calls, so the caller gets a clean 503 rather than its own timeout (after which
    /// it retries while the first invocation is still running).
    /// </summary>
    [Range(10, 110)]
    public int DeadlineSeconds { get; set; } = 90;

    /// <summary>
    /// Maximum concurrent Graph requests per instance. Graph allows 4 concurrent requests per app per mailbox;
    /// gating here keeps bursts queued in-process instead of being throttled (429) by Graph. The gate is per
    /// instance, so N instances can reach 4N; a high HTTP per-instance concurrency keeps N at 1 for most bursts,
    /// and Graph's own 429 + Retry-After (honoured by the retry handler) covers the rest.
    /// </summary>
    [Range(1, 16)]
    public int MaxConcurrentGraphRequests { get; set; } = 4;
}

/// <summary>Facts about the hosting platform, read once from App Service environment variables.</summary>
/// <param name="RunningInAzure">True when hosted in Azure (any of <see cref="AzureHostMarkers"/> is set).</param>
/// <param name="EasyAuthEnabled">True when App Service Authentication is enabled (WEBSITE_AUTH_ENABLED=True).</param>
public sealed record PlatformInfo(bool RunningInAzure, bool EasyAuthEnabled)
{
    // Which of these is present differs between hosting plans (App Service/Windows, Linux Consumption, Flex),
    // so check several. None is set by Core Tools locally. The deploy smoke test asserts the result via /api/health.
    internal static readonly string[] AzureHostMarkers = ["WEBSITE_INSTANCE_ID", "CONTAINER_NAME", "WEBSITE_SKU"];

    public static PlatformInfo FromEnvironment() => FromVariables(Environment.GetEnvironmentVariable);

    internal static PlatformInfo FromVariables(Func<string, string?> getVariable) => new(
        AzureHostMarkers.Any(name => !string.IsNullOrEmpty(getVariable(name))),
        string.Equals(getVariable("WEBSITE_AUTH_ENABLED"), "True", StringComparison.OrdinalIgnoreCase));

    /// <summary>True when the fail-closed check applies: in Azure, required, and Easy Auth is not reported as enabled.</summary>
    public bool RefusesRequests(SecurityOptions security)
        => RunningInAzure && security.RequireEasyAuthEnabled && !EasyAuthEnabled;
}
