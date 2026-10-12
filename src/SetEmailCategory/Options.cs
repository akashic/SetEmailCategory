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
}
