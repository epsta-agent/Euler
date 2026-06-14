from calc import sum_range


def test_sum_range_inclusive():
    assert sum_range(1, 3) == 6
    assert sum_range(1, 1) == 1
    assert sum_range(0, 4) == 10
    assert sum_range(5, 5) == 5
