def sum_range(lo: int, hi: int) -> int:
    # BUG: excludes hi (should be inclusive).
    total = 0
    for i in range(lo, hi):
        total += i
    return total
