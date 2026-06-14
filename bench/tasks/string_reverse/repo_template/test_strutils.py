from strutils import reverse, upper


def test_reverse():
    assert reverse("abc") == "cba"
    assert reverse("") == ""
    assert reverse("a") == "a"
    assert reverse("ab") == "ba"


def test_upper():
    assert upper("abc") == "ABC"
