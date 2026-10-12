using System.Net.Http.Headers;
using Azure.Core;

namespace SetEmailCategory.Graph;

/// <summary>Adds a Microsoft Graph app-only bearer token to each outgoing request. Azure.Identity caches tokens.</summary>
internal sealed class GraphAuthHandler(TokenCredential credential) : DelegatingHandler
{
    private static readonly TokenRequestContext GraphScope = new(["https://graph.microsoft.com/.default"]);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await credential.GetTokenAsync(GraphScope, cancellationToken).ConfigureAwait(false);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
