namespace SetEmailCategory.Models;

/// <summary>A request that passed validation, with categories trimmed and de-duplicated.</summary>
public sealed record ValidatedRequest(
    string? MessageId,
    string? InternetMessageId,
    IReadOnlyList<string> Categories,
    CategoryMode Mode);

public static class RequestValidator
{
    public const int MaxCategories = 25;
    public const int MaxCategoryLength = 255;
    public const int MaxIdLength = 1024;

    /// <summary>Validates and normalises a request. Returns null and populates <paramref name="errors"/> when invalid.</summary>
    public static ValidatedRequest? Validate(SetCategoryRequest? request, out IReadOnlyList<string> errors)
    {
        var problems = new List<string>();
        errors = problems;

        if (request is null)
        {
            problems.Add("Request body is required.");
            return null;
        }

        var messageId = request.MessageId?.Trim();
        var internetMessageId = request.InternetMessageId?.Trim();

        if (string.IsNullOrEmpty(messageId) && string.IsNullOrEmpty(internetMessageId))
        {
            problems.Add("Either 'messageId' or 'internetMessageId' is required.");
        }

        if (messageId?.Length > MaxIdLength || internetMessageId?.Length > MaxIdLength)
        {
            problems.Add($"Message identifiers must be at most {MaxIdLength} characters.");
        }

        var mode = request.Mode ?? CategoryMode.Add;
        var categories = new List<string>();

        if (request.Categories is null)
        {
            problems.Add("'categories' is required.");
        }
        else
        {
            foreach (var raw in request.Categories)
            {
                var name = raw?.Trim();
                if (string.IsNullOrEmpty(name))
                {
                    problems.Add("Category names cannot be empty.");
                    continue;
                }

                if (name.Length > MaxCategoryLength)
                {
                    problems.Add($"Category '{name[..20]}...' exceeds {MaxCategoryLength} characters.");
                    continue;
                }

                // Outlook treats commas as category separators; a comma almost always means the caller
                // passed "A, B" as one string instead of an array.
                if (name.Contains(','))
                {
                    problems.Add($"Category '{name}' contains a comma. Pass each category as a separate array item.");
                    continue;
                }

                if (!categories.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    categories.Add(name);
                }
            }

            if (categories.Count == 0 && mode != CategoryMode.Replace && problems.Count == 0)
            {
                problems.Add("At least one category is required (an empty list is only allowed with mode 'replace').");
            }

            if (categories.Count > MaxCategories)
            {
                problems.Add($"At most {MaxCategories} categories can be supplied.");
            }
        }

        return problems.Count == 0
            ? new ValidatedRequest(
                string.IsNullOrEmpty(messageId) ? null : messageId,
                string.IsNullOrEmpty(internetMessageId) ? null : internetMessageId,
                categories,
                mode)
            : null;
    }
}
