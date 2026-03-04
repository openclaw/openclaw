"""
RFQ helper functions for the Polymarket CLOB API.

This module provides utility functions for RFQ operations including
query parameter parsing and unit conversion.
"""

from typing import Optional, Dict, Any

from .rfq_types import GetRfqRequestsParams, GetRfqQuotesParams


# Token decimals constants
COLLATERAL_TOKEN_DECIMALS = 6  # USDC has 6 decimals
CONDITIONAL_TOKEN_DECIMALS = 6


def parse_units(value: str, decimals: int) -> int:
    """
    Convert a decimal string to smallest units (like wei for ETH).

    Args:
        value: Decimal string (e.g., "1.5")
        decimals: Number of decimal places (e.g., 6 for USDC)

    Returns:
        Integer in smallest units (e.g., 1500000 for "1.5" with 6 decimals)

    Examples:
        >>> parse_units("1.5", 6)
        1500000
        >>> parse_units("100", 6)
        100000000
        >>> parse_units("0.000001", 6)
        1
    """
    if "." in value:
        integer_part, decimal_part = value.split(".")
        # Pad or truncate decimal part to match decimals
        decimal_part = decimal_part[:decimals].ljust(decimals, "0")
        return int(integer_part + decimal_part)
    else:
        return int(value) * (10**decimals)


def to_camel_case(snake_str: str) -> str:
    """
    Convert snake_case string to camelCase.

    Args:
        snake_str: String in snake_case format

    Returns:
        String in camelCase format

    Examples:
        >>> to_camel_case("user_address")
        'userAddress'
        >>> to_camel_case("request_id")
        'requestId'
        >>> to_camel_case("size_usdc_min")
        'sizeUsdcMin'
    """
    components = snake_str.split("_")
    return components[0] + "".join(x.title() for x in components[1:])


def parse_rfq_requests_params(params: Optional[GetRfqRequestsParams] = None) -> Dict[str, Any]:
    """
    Convert GetRfqRequestsParams to query string parameters.

    Arrays are kept as Python lists so the caller can serialize them with
    `urllib.parse.urlencode(..., doseq=True)` (repeated query params).

    Args:
        params: Optional filter parameters

    Returns:
        Dictionary of query parameters ready for HTTP request
    """
    if params is None:
        return {}

    result = {}

    # Single value fields (convert snake_case to camelCase)
    single_fields = [
        ("state", "state"),
        ("size_min", "sizeMin"),
        ("size_max", "sizeMax"),
        ("size_usdc_min", "sizeUsdcMin"),
        ("size_usdc_max", "sizeUsdcMax"),
        ("price_min", "priceMin"),
        ("price_max", "priceMax"),
        ("sort_by", "sortBy"),
        ("sort_dir", "sortDir"),
        ("limit", "limit"),
        ("offset", "offset"),
    ]

    for python_name, api_name in single_fields:
        value = getattr(params, python_name, None)
        if value is not None:
            result[api_name] = value

    # Array fields (keep as lists; let urlencode(doseq=True) expand them)
    if params.request_ids:
        result["requestIds"] = params.request_ids
    if params.markets:
        result["markets"] = params.markets

    return result


def parse_rfq_quotes_params(params: Optional[GetRfqQuotesParams] = None) -> Dict[str, Any]:
    """
    Convert GetRfqQuotesParams to query string parameters.

    Arrays are kept as Python lists so the caller can serialize them with
    `urllib.parse.urlencode(..., doseq=True)` (repeated query params).

    Args:
        params: Optional filter parameters

    Returns:
        Dictionary of query parameters ready for HTTP request
    """
    if params is None:
        return {}

    result = {}

    # Single value fields (convert snake_case to camelCase)
    single_fields = [
        ("state", "state"),
        ("size_min", "sizeMin"),
        ("size_max", "sizeMax"),
        ("size_usdc_min", "sizeUsdcMin"),
        ("size_usdc_max", "sizeUsdcMax"),
        ("price_min", "priceMin"),
        ("price_max", "priceMax"),
        ("sort_by", "sortBy"),
        ("sort_dir", "sortDir"),
        ("limit", "limit"),
        ("offset", "offset"),
    ]

    for python_name, api_name in single_fields:
        value = getattr(params, python_name, None)
        if value is not None:
            result[api_name] = value

    # Array fields (keep as lists; let urlencode(doseq=True) expand them)
    if params.quote_ids:
        result["quoteIds"] = params.quote_ids
    if params.request_ids:
        result["requestIds"] = params.request_ids
    if params.markets:
        result["markets"] = params.markets

    return result
