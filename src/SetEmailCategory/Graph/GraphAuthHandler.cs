using System.Net.Http.Headers;
using Azure.Core;
using Microsoft.Extensions.Options;

namespace SetEmailCategory.Graph;

/// <summary>Adds a Microsoft Graph app-only bearer token to each outgoing request. Azure.Identity caches tokens.</summary>
internal sealed class GraphAuthHandler(TokenCredential credential, IOptions<SharedMailboxOptions> options) : DelegatingHandler
{
    private readonly TokenRequestContext _graphScope = new([options.Value.GraphTokenScope]);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await credential.GetTokenAsync(_graphScope, cancellationToken).ConfigureAwait(false);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
