using System.Text.Json.Serialization;

namespace SetEmailCategory.Graph;

internal sealed class GraphMessage
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("categories")]
    public List<string> Categories { get; set; } = [];

    [JsonPropertyName("@odata.etag")]
    public string? ETag { get; set; }
}

internal sealed class GraphCollection<T>
{
    [JsonPropertyName("value")]
    public List<T> Value { get; set; } = [];
}

internal sealed class GraphErrorEnvelope
{
    [JsonPropertyName("error")]
    public GraphErrorBody? Error { get; set; }
}

internal sealed class GraphErrorBody
{
    [JsonPropertyName("code")]
    public string? Code { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}
