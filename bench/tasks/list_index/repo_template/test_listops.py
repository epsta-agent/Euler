import pytest
from listops import get_item


def test_first_item():
    assert get_item(['a', 'b', 'c'], 0) == 'a'


def test_middle_item():
    assert get_item(['a', 'b', 'c'], 1) == 'b'


def test_last_item():
    assert get_item(['a', 'b', 'c'], 2) == 'c'


def test_out_of_range():
    with pytest.raises(IndexError):
        get_item(['a', 'b'], 5)
