using SetEmailCategory.Models;

namespace SetEmailCategory.Tests;

public class RequestValidatorTests
{
    [Fact]
    public void Null_body_is_rejected()
    {
        Assert.Null(RequestValidator.Validate(null, out var errors));
        Assert.Contains("Request body is required.", errors);
    }

    [Fact]
    public void Requires_a_message_identifier()
    {
        Assert.Null(RequestValidator.Validate(new SetCategoryRequest(" ", null, ["A"], null), out var errors));
        Assert.Contains(errors, e => e.Contains("messageId"));
    }

    [Fact]
    public void Defaults_to_add_and_trims_and_dedupes_case_insensitively()
    {
        var result = RequestValidator.Validate(new SetCategoryRequest(" id-1 ", null, [" Invoice ", "invoice", "Urgent"], null), out _);

        Assert.NotNull(result);
        Assert.Equal("id-1", result.MessageId);
        Assert.Equal(CategoryMode.Add, result.Mode);
        Assert.Equal(["Invoice", "Urgent"], result.Categories);
    }

    [Fact]
    public void Rejects_comma_separated_string()
    {
        Assert.Null(RequestValidator.Validate(new SetCategoryRequest("id", null, ["A, B"], null), out var errors));
        Assert.Contains(errors, e => e.Contains("comma"));
    }

    [Fact]
    public void Rejects_overlong_category()
    {
        var name = new string('x', RequestValidator.MaxCategoryLength + 1);
        Assert.Null(RequestValidator.Validate(new SetCategoryRequest("id", null, [name], null), out _));
    }

    [Fact]
    public void Rejects_too_many_categories()
    {
        var names = Enumerable.Range(0, RequestValidator.MaxCategories + 1).Select(i => $"C{i}").ToList();
        Assert.Null(RequestValidator.Validate(new SetCategoryRequest("id", null, names, null), out _));
    }

    [Theory]
    [InlineData(CategoryMode.Add, false)]
    [InlineData(CategoryMode.Remove, false)]
    [InlineData(CategoryMode.Replace, true)]
    public void Empty_category_list_only_allowed_for_replace(CategoryMode mode, bool valid)
    {
        var result = RequestValidator.Validate(new SetCategoryRequest("id", null, [], mode), out _);
        Assert.Equal(valid, result is not null);
    }

    [Theory]
    [InlineData("abc@contoso.com", "<abc@contoso.com>")]
    [InlineData("<abc@contoso.com>", "<abc@contoso.com>")]
    [InlineData("  <abc@contoso.com  ", "<abc@contoso.com>")]
    [InlineData("abc@contoso.com>", "<abc@contoso.com>")]
    [InlineData("< abc@contoso.com >", "<abc@contoso.com>")]
    [InlineData("<>", null)]
    [InlineData("   ", null)]
    [InlineData(null, null)]
    public void Normalizes_internet_message_id_to_bracketed_form(string? input, string? expected)
        => Assert.Equal(expected, RequestValidator.NormalizeInternetMessageId(input));

    [Fact]
    public void Validate_applies_internet_message_id_normalization()
    {
        var result = RequestValidator.Validate(new SetCategoryRequest(null, "abc@contoso.com", ["A"], null), out _);
        Assert.Equal("<abc@contoso.com>", result!.InternetMessageId);
    }

    [Fact]
    public void Missing_categories_is_rejected()
    {
        Assert.Null(RequestValidator.Validate(new SetCategoryRequest("id", null, null, CategoryMode.Replace), out var errors));
        Assert.Contains("'categories' is required.", errors);
    }
}
