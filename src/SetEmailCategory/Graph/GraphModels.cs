using System.Text.Json.Serialization;

namespace SetEmailCategory.Graph;

// Collection setters coalesce null: System.Text.Json assigns an explicit JSON null over the initializer,
// and a null list here would surface as a NullReferenceException far from the cause.

internal sealed class GraphMessage
{
    private List<string> _categories = [];

    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("categories")]
    public List<string> Categories
    {
        get => _categories;
        set => _categories = value ?? [];
    }

    [JsonPropertyName("@odata.etag")]
    public string? ETag { get; set; }
}

internal sealed class GraphCollection<T>
{
    private List<T> _value = [];

    [JsonPropertyName("value")]
    public List<T> Value
    {
        get => _value;
        set => _value = value ?? [];
    }
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
