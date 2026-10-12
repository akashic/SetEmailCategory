using System.ComponentModel.DataAnnotations;
using Azure.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SetEmailCategory.Graph;
using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

/// <summary>GraphBaseUrl drives both the request URLs and the token audience, so a national cloud needs one setting.</summary>
public class GraphCloudOptionsTests
{
    private sealed class RecordingCredential : TokenCredential
    {
        public List<string> Scopes { get; } = [];

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            Scopes.AddRange(requestContext.Scopes);
            return new AccessToken("test-token", DateTimeOffset.UtcNow.AddHours(1));
        }

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
            => ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    [Theory]
    [InlineData("https://graph.microsoft.com/v1.0/", "https://graph.microsoft.com/.default")]
    [InlineData("https://graph.microsoft.us/v1.0/", "https://graph.microsoft.us/.default")]
    [InlineData("https://dod-graph.microsoft.us/v1.0", "https://dod-graph.microsoft.us/.default")]
    [InlineData("https://microsoftgraph.chinacloudapi.cn/v1.0/", "https://microsoftgraph.chinacloudapi.cn/.default")]
    public void Token_scope_follows_the_graph_base_url(string baseUrl, string expectedScope)
        => Assert.Equal(expectedScope, new SharedMailboxOptions { GraphBaseUrl = baseUrl }.GraphTokenScope);

    [Fact]
    public void Base_uri_gets_a_trailing_slash_so_the_version_segment_is_kept()
    {
        var baseUri = new SharedMailboxOptions { GraphBaseUrl = "https://graph.microsoft.com/v1.0" }.GraphBaseUri;

        Assert.Equal("https://graph.microsoft.com/v1.0/users/x", new Uri(baseUri, "users/x").ToString());
    }

    [Theory]
    [InlineData("http://graph.microsoft.com/v1.0/")]
    [InlineData("graph.microsoft.com/v1.0/")]
    public void Non_https_base_url_fails_validation(string baseUrl)
    {
        var options = new SharedMailboxOptions { Address = "shared@contoso.com", GraphBaseUrl = baseUrl };

        Assert.False(Validator.TryValidateObject(options, new ValidationContext(options), [], validateAllProperties: true));
    }

    [Fact]
    public void Default_options_pass_validation()
    {
        var options = new SharedMailboxOptions { Address = "shared@contoso.com" };

        Assert.True(Validator.TryValidateObject(options, new ValidationContext(options), [], validateAllProperties: true));
    }

    [Fact]
    public async Task Real_pipeline_requests_a_token_for_the_configured_cloud_and_keeps_the_version_segment()
    {
        var fake = new FakeGraphHandler();
        fake.RespondMessage("msg-1", ["Only"]);
        var credential = new RecordingCredential();

        var services = new ServiceCollection();
        services.AddLogging(b => b.SetMinimumLevel(LogLevel.Warning));
        services.AddSingleton<TokenCredential>(credential);
        services.AddOptions<SharedMailboxOptions>().Configure(o =>
        {
            o.Address = "shared@contoso.com";
            o.GraphBaseUrl = "https://graph.microsoft.us/v1.0"; // no trailing slash
        });
        services.AddOptions<ProcessingOptions>();
        services.AddGraphClient().ConfigurePrimaryHttpMessageHandler(() => fake);

        await using var provider = services.BuildServiceProvider();
        var outcome = await provider.GetRequiredService<IMailCategoryService>()
            .ApplyAsync(new ValidatedRequest("msg-1", null, ["Only"], CategoryMode.Replace), default);

        Assert.Equal(CategoryOutcomeStatus.Success, outcome.Status);
        Assert.Equal(["https://graph.microsoft.us/.default"], credential.Scopes.Distinct());
        Assert.StartsWith("/v1.0/users/", fake.Requests.Single().PathAndQuery);
    }
}
