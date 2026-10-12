using Azure.Core;
using Azure.Identity;
using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Azure.Functions.Worker.OpenTelemetry;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenTelemetry;
using OpenTelemetry.Logs;
using SetEmailCategory;
using SetEmailCategory.Graph;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

var platform = PlatformInfo.FromEnvironment();
builder.Services.AddSingleton(platform);

// In Azure, use the app's system-assigned managed identity explicitly (deterministic, no credential probing).
// Locally, DefaultAzureCredential picks up AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_CLIENT_SECRET for a dev app registration.
TokenCredential credential = platform.RunningInAzure
    ? new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned)
    : new DefaultAzureCredential();
builder.Services.AddSingleton(credential);

if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APPLICATIONINSIGHTS_CONNECTION_STRING")))
{
    builder.Services.AddOpenTelemetry()
        .UseFunctionsWorkerDefaults()
        // Application Insights has local (key) auth disabled, so telemetry is sent with Entra ID.
        .UseAzureMonitorExporter(o => o.Credential = credential);

    // Export logging scopes (CallerId, CorrelationId) as customDimensions for audit queries.
    builder.Services.Configure<OpenTelemetryLoggerOptions>(o => o.IncludeScopes = true);
}

builder.Services.AddOptions<SharedMailboxOptions>()
    .Bind(builder.Configuration.GetSection(SharedMailboxOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddOptions<SecurityOptions>()
    .Bind(builder.Configuration.GetSection(SecurityOptions.SectionName));

builder.Services.AddOptions<ProcessingOptions>()
    .Bind(builder.Configuration.GetSection(ProcessingOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddGraphClient();

builder.Build().Run();
