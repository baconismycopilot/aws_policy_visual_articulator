# TESTS := tests
SRC := app/
SRCS := $(wildcard *.py) $(SRC)
CLEAN := htmlcov/ .coverage .ruff_cache/ .mypy_cache/ .pytest_cache/ __pycache__/

# There are ways of doing this automatically, just hush and update it as you see fit.
.PHONY: help
help:
	@echo "Usage: $(MAKE) <clean | format | lint | test | unittest>"
	@exit 1

.PHONY: clean
clean:
	@rm -rf $(CLEAN)
	@find $(SRCS) -type d -name __pycache__ -print0 | xargs -0 -n1 -P0 rm -rf

.PHONY: format
format:
	ruff format $(SRCS)
	ruff check --fix $(SRCS)

.PHONY: lint
lint: format
	mypy $(SRC)

.PHONY: test
test:
	python -m pytest $(TESTS)

.PHONY: unittest
unittest: clean lint test
