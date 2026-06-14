from strings import is_blank, is_present


def test_empty_string():
    assert is_blank("") is True


def test_whitespace_only():
    assert is_blank("   ") is True
    assert is_blank("\t\n") is True


def test_non_blank():
    assert is_blank("abc") is False
    assert is_blank(" a ") is False


def test_is_present():
    assert is_present("abc") is True
    assert is_present("   ") is False
