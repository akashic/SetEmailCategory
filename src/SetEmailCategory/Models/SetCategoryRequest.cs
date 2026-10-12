using System.Text.Json.Serialization;

namespace SetEmailCategory.Models;

/// <summary>How the supplied categories are combined with the message's existing categories.</summary>
[JsonConverter(typeof(StrictStringEnumConverter<CategoryMode>))]
public enum CategoryMode
{
    /// <summary>Add the categories, keeping any already on the message.</summary>
    Add,

    /// <summary>Replace all categories on the message with the supplied list (an empty list clears them).</summary>
    Replace,

    /// <summary>Remove the supplied categories from the message.</summary>
    Remove,
}

/// <summary>
/// Accepts enum names only (case-insensitive). The default converter also accepts integers, so "mode": 99 would
/// deserialise to an undefined <see cref="CategoryMode"/>.
/// </summary>
internal sealed class StrictStringEnumConverter<TEnum>() : JsonStringEnumConverter<TEnum>(namingPolicy: null, allowIntegerValues: false)
    where TEnum : struct, Enum;

/// <summary>Request body accepted by the SetCategory function.</summary>
/// <param name="MessageId">Graph/Outlook REST message ID (the "Message Id" output of the Outlook connector trigger).</param>
/// <param name="InternetMessageId">RFC 2822 Message-ID header. Used to locate the message when <paramref name="MessageId"/> is not supplied, e.g. after the message was moved.</param>
/// <param name="Categories">Category display names.</param>
/// <param name="Mode">Defaults to <see cref="CategoryMode.Add"/>.</param>
public sealed record SetCategoryRequest(
    string? MessageId,
    string? InternetMessageId,
    IReadOnlyList<string>? Categories,
    CategoryMode? Mode);

/// <summary>Successful response body.</summary>
/// <param name="MessageId">The ID of the message that was updated.</param>
/// <param name="Categories">The message's categories after the update.</param>
/// <param name="Changed">False when the message already had the requested categories and no write was made.</param>
public sealed record SetCategoryResponse(
    string MessageId,
    IReadOnlyList<string> Categories,
    bool Changed);
