"""Temporary: proves required status checks block a merge. Deleted immediately."""


def test_deliberately_failing():
    assert False, "intentional failure to verify branch protection"
