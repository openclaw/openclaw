"""
RFQ (Request for Quote) data types for the Polymarket CLOB API.

This module defines all input and response types used by the RFQ client.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Any, Literal
from enum import Enum


# =============================================================================
# Input Types
# =============================================================================


@dataclass
class RfqUserRequest:
    """
    Simplified user input for creating an RFQ request.

    This is the user-facing order format that gets converted to
    CreateRfqRequestParams for the API.
    """

    token_id: str
    """Token ID of the conditional token being traded."""

    price: float
    """Price per token (0 < price < 1)."""

    side: str
    """Order side: "BUY" or "SELL"."""

    size: float
    """Size in conditional tokens."""


@dataclass
class RfqUserQuote:
    """
    Simplified user input for creating an RFQ quote.

    This is the user-facing quote format that gets converted to
    CreateRfqQuoteParams for the API.
    """

    request_id: str
    """ID of the RFQ request being quoted."""

    token_id: str
    """Token ID of the conditional token being traded."""

    price: float
    """Price per token (0 < price < 1)."""

    side: str
    """Quoter's side: "BUY" or "SELL"."""

    size: float
    """Size in conditional tokens."""


@dataclass
class CreateRfqRequestParams:
    """
    Server payload for creating an RFQ request.

    This is the format sent to the API after converting from RfqUserRequest.
    """

    asset_in: str
    """Asset being received (token ID or "0" for USDC)."""

    asset_out: str
    """Asset being paid (token ID or "0" for USDC)."""

    amount_in: str
    """Amount being received (in smallest units, as string)."""

    amount_out: str
    """Amount being paid (in smallest units, as string)."""

    user_type: int
    """Signature type (0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE)."""


@dataclass
class CreateRfqQuoteParams:
    """
    Parameters for creating a quote in response to an RFQ request.
    """

    request_id: str
    """ID of the RFQ request being quoted."""

    asset_in: str
    """Asset the quoter is paying."""

    asset_out: str
    """Asset the quoter is receiving."""

    amount_in: str
    """Amount quoter is paying (in smallest units)."""

    amount_out: str
    """Amount quoter is receiving (in smallest units)."""

    # Note: user_type is auto-filled by the client


@dataclass
class CancelRfqRequestParams:
    """
    Parameters for canceling an RFQ request.
    """

    request_id: str
    """ID of the request to cancel."""


@dataclass
class CancelRfqQuoteParams:
    """
    Parameters for canceling an RFQ quote.
    """

    quote_id: str
    """ID of the quote to cancel."""


@dataclass
class AcceptQuoteParams:
    """
    Parameters for accepting a quote (requester side).

    When a requester accepts a quote, they create a signed order
    and submit it with this payload.
    """

    request_id: str
    """ID of the RFQ request."""

    quote_id: str
    """ID of the quote being accepted."""

    expiration: int
    """Unix timestamp for order expiration."""


@dataclass
class ApproveOrderParams:
    """
    Parameters for approving an order (quoter side).

    When a quoter's quote is accepted, they approve by creating
    a signed order and submitting it with this payload.
    """

    request_id: str
    """ID of the RFQ request."""

    quote_id: str
    """ID of the quote being approved."""

    expiration: int
    """Unix timestamp for order expiration."""


@dataclass
class GetRfqRequestsParams:
    """
    Query parameters for fetching RFQ requests.

    All fields are optional filters.
    """

    request_ids: Optional[List[str]] = None
    """Filter by specific request IDs (query param: requestIds; repeatable)."""

    state: Optional[Literal["active", "inactive"]] = None
    """Single state filter ("active" or "inactive")."""

    markets: Optional[List[str]] = None
    """Filter by market condition IDs (query param: markets; repeatable)."""

    size_min: Optional[float] = None
    """Minimum size filter."""

    size_max: Optional[float] = None
    """Maximum size filter."""

    size_usdc_min: Optional[float] = None
    """Minimum USDC size filter."""

    size_usdc_max: Optional[float] = None
    """Maximum USDC size filter."""

    price_min: Optional[float] = None
    """Minimum price filter."""

    price_max: Optional[float] = None
    """Maximum price filter."""

    sort_by: Optional[Literal["price", "expiry", "size", "created"]] = None
    """Field to sort by."""

    sort_dir: Optional[Literal["asc", "desc"]] = None
    """Sort direction: "asc" or "desc"."""

    limit: Optional[int] = None
    """Pagination limit."""

    offset: Optional[str] = None
    """Pagination cursor (base64 encoded)."""


@dataclass
class GetRfqQuotesParams:
    """
    Query parameters for fetching RFQ quotes.

    All fields are optional filters.
    """

    quote_ids: Optional[List[str]] = None
    """Filter by specific quote IDs (query param: quoteIds; repeatable)."""

    request_ids: Optional[List[str]] = None
    """Filter by request IDs (query param: requestIds; repeatable)."""

    state: Optional[Literal["active", "inactive"]] = None
    """Single state filter ("active" or "inactive")."""

    markets: Optional[List[str]] = None
    """Filter by market condition IDs (query param: markets; repeatable)."""

    size_min: Optional[float] = None
    """Minimum size filter."""

    size_max: Optional[float] = None
    """Maximum size filter."""

    size_usdc_min: Optional[float] = None
    """Minimum USDC size filter."""

    size_usdc_max: Optional[float] = None
    """Maximum USDC size filter."""

    price_min: Optional[float] = None
    """Minimum price filter."""

    price_max: Optional[float] = None
    """Maximum price filter."""

    sort_by: Optional[Literal["price", "expiry", "created"]] = None
    """Field to sort by."""

    sort_dir: Optional[Literal["asc", "desc"]] = None
    """Sort direction: "asc" or "desc"."""

    limit: Optional[int] = None
    """Pagination limit."""

    offset: Optional[str] = None
    """Pagination cursor (base64 encoded)."""


@dataclass
class GetRfqBestQuoteParams:
    """
    Parameters for fetching the best quote for a request.
    """

    request_id: Optional[str] = None
    """Request ID to get best quote for."""


# =============================================================================
# Response Types
# =============================================================================


@dataclass
class RfqRequest:
    """
    Full RFQ request object returned by the API.
    """

    request_id: str
    """Unique request identifier."""

    user_address: str
    """Address of the requester."""

    proxy_address: Optional[str] = None
    """Proxy address if applicable."""

    token: Optional[str] = None
    """Token ID being traded."""

    complement: Optional[str] = None
    """Complement token ID."""

    condition: Optional[str] = None
    """Condition ID (market)."""

    side: Optional[str] = None
    """Order side: "BUY" or "SELL"."""

    size_in: Optional[str] = None
    """Size of asset_in."""

    size_out: Optional[str] = None
    """Size of asset_out."""

    price: Optional[float] = None
    """Price."""

    accepted_quote_id: Optional[str] = None
    """ID of accepted quote (if any)."""

    state: Optional[str] = None
    """Request state."""

    expiry: Optional[str] = None
    """Expiration timestamp."""

    created_at: Optional[str] = None
    """Creation timestamp."""

    updated_at: Optional[str] = None
    """Last update timestamp."""


@dataclass
class RfqQuote:
    """
    Full RFQ quote object returned by the API.
    """

    quote_id: str
    """Unique quote identifier."""

    request_id: str
    """Associated request ID."""

    user_address: str
    """Address of the quoter."""

    proxy_address: Optional[str] = None
    """Proxy address if applicable."""

    complement: Optional[str] = None
    """Complement token ID."""

    condition: Optional[str] = None
    """Condition ID (market)."""

    token: Optional[str] = None
    """Token ID."""

    side: Optional[str] = None
    """Quote side: "BUY" or "SELL"."""

    size_in: Optional[str] = None
    """Size of asset_in."""

    size_out: Optional[str] = None
    """Size of asset_out."""

    price: Optional[float] = None
    """Quote price."""

    state: Optional[str] = None
    """Quote state."""

    expiry: Optional[str] = None
    """Expiration timestamp."""

    created_at: Optional[str] = None
    """Creation timestamp."""

    updated_at: Optional[str] = None
    """Last update timestamp."""


@dataclass
class RfqRequestResponse:
    """
    Response from creating an RFQ request.
    """

    request_id: Optional[str] = None
    """Created request ID."""

    error: Optional[str] = None
    """Error message if failed."""


@dataclass
class RfqQuoteResponse:
    """
    Response from creating an RFQ quote.
    """

    quote_id: Optional[str] = None
    """Created quote ID."""

    error: Optional[str] = None
    """Error message if failed."""


@dataclass
class RfqPaginatedResponse:
    """
    Paginated response for list queries.
    """

    data: List[Any] = field(default_factory=list)
    """Array of results (RfqRequest or RfqQuote objects)."""

    next_cursor: Optional[str] = None
    """Cursor for next page."""

    limit: Optional[int] = None
    """Page limit."""

    count: Optional[int] = None
    """Number of results in this page."""

    total_count: Optional[int] = None
    """Total count (optional)."""


class MatchType(str, Enum):
    COMPLEMENTARY = "COMPLEMENTARY"
    MINT = "MINT"
    MERGE = "MERGE"
