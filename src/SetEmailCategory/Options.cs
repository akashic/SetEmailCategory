using System.ComponentModel.DataAnnotations;

namespace SetEmailCategory;

/// <summary>Bound from the "SharedMailbox" configuration section (app setting <c>SharedMailbox__Address</c>).</summary>
public sealed class SharedMailboxOptions
{
    public const string SectionName = "SharedMailbox";

    /// <summary>SMTP address (or Entra object ID) of the shared mailbox this app is allowed to modify.</summary>
    [Required]
    public string Address { get; set; } = string.Empty;

    /// <summary>Microsoft Graph base URL. Override only for national clouds.</summary>
    [Required]
    [Url]
    public string GraphBaseUrl { get; set; } = "https://graph.microsoft.com/v1.0/";
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

/// <summary>Facts about the hosting platform, read once from App Service environment variables.</summary>
/// <param name="RunningInAzure">True on App Service / Functions hosting (WEBSITE_INSTANCE_ID is set).</param>
/// <param name="EasyAuthEnabled">True when App Service Authentication is enabled (WEBSITE_AUTH_ENABLED=True).</param>
public sealed record PlatformInfo(bool RunningInAzure, bool EasyAuthEnabled)
{
    public static PlatformInfo FromEnvironment() => new(
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WEBSITE_INSTANCE_ID")),
        string.Equals(Environment.GetEnvironmentVariable("WEBSITE_AUTH_ENABLED"), "True", StringComparison.OrdinalIgnoreCase));
}
