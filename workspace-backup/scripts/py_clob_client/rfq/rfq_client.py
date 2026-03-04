"""
RFQ (Request for Quote) client for the Polymarket CLOB API.

This module provides the RfqClient class which handles all RFQ operations
including creating requests, quotes, and executing trades.
"""

import logging
import json
from urllib.parse import urlencode
from typing import Optional, Any, TYPE_CHECKING

from ..clob_types import RequestArgs, OrderArgs, PartialCreateOrderOptions
from ..headers.headers import create_level_2_headers
from ..http_helpers.helpers import get, post, delete
from ..order_builder.builder import ROUNDING_CONFIG
from ..order_builder.helpers import round_normal, round_down
from ..order_builder.constants import BUY, SELL
from ..endpoints import (
    CREATE_RFQ_REQUEST,
    CANCEL_RFQ_REQUEST,
    GET_RFQ_REQUESTS,
    CREATE_RFQ_QUOTE,
    CANCEL_RFQ_QUOTE,
    GET_RFQ_REQUESTER_QUOTES,
    GET_RFQ_QUOTER_QUOTES,
    GET_RFQ_BEST_QUOTE,
    RFQ_REQUESTS_ACCEPT,
    RFQ_QUOTE_APPROVE,
    RFQ_CONFIG,
)

from .rfq_types import (
    RfqUserRequest,
    RfqUserQuote,

    CancelRfqRequestParams,
    CancelRfqQuoteParams,
    AcceptQuoteParams,
    ApproveOrderParams,
    GetRfqRequestsParams,
    GetRfqQuotesParams,
    GetRfqBestQuoteParams,
    MatchType,
)
from .rfq_helpers import (
    parse_units,
    parse_rfq_requests_params,
    parse_rfq_quotes_params,
    COLLATERAL_TOKEN_DECIMALS,
)

if TYPE_CHECKING:
    from ..client import ClobClient


class RfqClient:
    """
    RFQ client for creating and managing RFQ requests and quotes.

    This client is typically accessed via the parent ClobClient's `rfq` attribute:

        client = ClobClient(host, chain_id, key, creds)
        response = client.rfq.create_rfq_request(user_request)
    """

    def __init__(self, parent: "ClobClient"):
        """
        Initialize the RFQ client.

        Args:
            parent: The parent ClobClient instance providing auth and config.
        """
        self._parent = parent
        self.logger = logging.getLogger(self.__class__.__name__)

    def _ensure_l2_auth(self) -> None:
        """
        Verify that L2 authentication is available.

        Raises:
            PolyException: If signer or creds are not configured.
        """
        self._parent.assert_level_2_auth()

    def _get_l2_headers(self, method: str, endpoint: str, body: Any = None, serialized_body: Any = None) -> dict:
        """
        Create L2 authentication headers for a request.

        Args:
            method: HTTP method (GET, POST, PUT, DELETE)
            endpoint: API endpoint path
            body: Optional request body

        Returns:
            Dictionary of authentication headers.
        """
        request_args = RequestArgs(method=method, request_path=endpoint, body=body)
        if serialized_body is not None:
            request_args.serialized_body = serialized_body

        return create_level_2_headers(
            self._parent.signer,
            self._parent.creds,
            request_args,
        )

    def _build_url(self, endpoint: str) -> str:
        """Build full URL from endpoint."""
        return f"{self._parent.host}{endpoint}"

    # =========================================================================
    # Request-side methods
    # =========================================================================

    def create_rfq_request(
        self,
        user_request: RfqUserRequest,
        options: Optional[PartialCreateOrderOptions] = None,
    ) -> dict:
        """
        Create and post an RFQ request from a user request.

        This method:
        1. Resolves the tick size for the token
        2. Rounds price and size according to tick size rules
        3. Calculates amount_in and amount_out based on side
        4. Posts the request to the server

        Args:
            user_order: Simplified order with token_id, price, side, size
            options: Optional tick size override

        Returns:
            Response dict with request_id on success.

        Example:
            >>> response = client.rfq.create_rfq_request(
            ...     RfqUserRequest(
            ...         token_id="123...",
            ...         price=0.5,
            ...         side="BUY",
            ...         size=40,
            ...     )
            ... )
        """
        token_id = user_request.token_id
        price = user_request.price
        side = user_request.side
        size = user_request.size

        # Resolve tick size (from options or fetch from server)
        tick_size = self._parent._ClobClient__resolve_tick_size(
            token_id,
            options.tick_size if options else None,
        )

        # Get rounding configuration (ensure tick_size is a string for lookup)
        tick_size_str = str(tick_size) if not isinstance(tick_size, str) else tick_size
        round_config = ROUNDING_CONFIG[tick_size_str]

        # Round price and size
        rounded_price = round_normal(price, round_config.price)
        rounded_size = round_down(size, round_config.size)

        # Format with correct decimal places
        price_decimals = int(round_config.price)
        size_decimals = int(round_config.size)
        amount_decimals = int(round_config.amount)

        rounded_price_str = f"{rounded_price:.{price_decimals}f}"
        rounded_size_str = f"{rounded_size:.{size_decimals}f}"

        # Parse back to numbers for calculation
        size_num = float(rounded_size_str)
        price_num = float(rounded_price_str)

        # Get signature type from parent's order builder
        user_type = self._parent.builder.sig_type

        # Calculate amounts based on side
        if side == BUY:
            # Buying tokens: pay USDC, receive tokens
            # asset_in = tokens (what requester receives)
            # asset_out = USDC (what requester pays)
            amount_in = parse_units(rounded_size_str, COLLATERAL_TOKEN_DECIMALS)

            usdc_amount = size_num * price_num
            usdc_amount_str = f"{usdc_amount:.{amount_decimals}f}"
            amount_out = parse_units(usdc_amount_str, COLLATERAL_TOKEN_DECIMALS)

            asset_in = token_id
            asset_out = "0"  # USDC
        else:
            # Selling tokens: pay tokens, receive USDC
            # asset_in = USDC (what requester receives)
            # asset_out = tokens (what requester pays)
            usdc_amount = size_num * price_num
            usdc_amount_str = f"{usdc_amount:.{amount_decimals}f}"
            amount_in = parse_units(usdc_amount_str, COLLATERAL_TOKEN_DECIMALS)

            amount_out = parse_units(rounded_size_str, COLLATERAL_TOKEN_DECIMALS)

            asset_in = "0"  # USDC
            asset_out = token_id

        # Post directly to the server
        self._ensure_l2_auth()

        body = {
            "assetIn": asset_in,
            "assetOut": asset_out,
            "amountIn": str(amount_in),
            "amountOut": str(amount_out),
            "userType": user_type,
        }
        serialized_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("POST", CREATE_RFQ_REQUEST, body, serialized_body)
        return post(self._build_url(CREATE_RFQ_REQUEST), headers=headers, data=serialized_body)

    def cancel_rfq_request(self, params: CancelRfqRequestParams) -> str:
        """
        Cancel an RFQ request.

        Args:
            params: Contains request_id to cancel.

        Returns:
            "OK" on success.
        """
        self._ensure_l2_auth()

        body = {"requestId": params.request_id}
        serialized_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("DELETE", CANCEL_RFQ_REQUEST, body, serialized_body)
        return delete(self._build_url(CANCEL_RFQ_REQUEST), headers=headers, data=serialized_body)

    def get_rfq_requests(
        self, params: Optional[GetRfqRequestsParams] = None
    ) -> dict:
        """
        Get RFQ requests with optional filtering.

        Args:
            params: Optional filter parameters.

        Returns:
            Paginated response with RFQ requests.
        """
        self._ensure_l2_auth()

        headers = self._get_l2_headers("GET", GET_RFQ_REQUESTS)
        query_params = parse_rfq_requests_params(params)

        # Build URL with query params
        url = self._build_url(GET_RFQ_REQUESTS)
        if query_params:
            # Use doseq=True so list values become repeated query params:
            # requestIds=id1&requestIds=id2
            url = f"{url}?{urlencode(query_params, doseq=True)}"

        return get(url, headers=headers)

    # =========================================================================
    # Quote-side methods
    # =========================================================================

    def create_rfq_quote(
        self,
        user_quote: RfqUserQuote,
        options: Optional[PartialCreateOrderOptions] = None,
    ) -> dict:
        """
        Create and post an RFQ quote in response to an RFQ request.

        This method:
        1. Fetches the RFQ request to get token_id
        2. Resolves the tick size for the token
        3. Rounds price and size according to tick size rules
        4. Calculates amount_in and amount_out based on side
        5. Posts the quote to the server

        Args:
            user_quote: Simplified quote with request_id, token_id, price, side, size
            options: Optional tick size override

        Returns:
            Response dict with quote_id on success.

        Example:
            >>> response = client.rfq.create_rfq_quote(
            ...     RfqUserQuote(
            ...         request_id="019a83a9-f4c7-7c96-9139-2da2b2d934ef",
            ...         token_id="123...",
            ...         price=0.5,
            ...         side="SELL",
            ...         size=100.0,
            ...     )
            ... )
        """

        request_id = user_quote.request_id
        token_id = user_quote.token_id
        price = user_quote.price
        side = user_quote.side
        size = user_quote.size

        # Resolve tick size (from options or fetch from server)
        tick_size = self._parent._ClobClient__resolve_tick_size(
            token_id,
            options.tick_size if options else None,
        )

        # Get rounding configuration (ensure tick_size is a string for lookup)
        tick_size_str = str(tick_size) if not isinstance(tick_size, str) else tick_size
        round_config = ROUNDING_CONFIG[tick_size_str]

        # Round price and size
        rounded_price = round_normal(price, round_config.price)
        rounded_size = round_down(size, round_config.size)

        # Format with correct decimal places
        price_decimals = int(round_config.price)
        size_decimals = int(round_config.size)
        amount_decimals = int(round_config.amount)

        rounded_price_str = f"{rounded_price:.{price_decimals}f}"
        rounded_size_str = f"{rounded_size:.{size_decimals}f}"

        # Parse back to numbers for calculation
        size_num = float(rounded_size_str)
        price_num = float(rounded_price_str)

        # Get signature type from parent's order builder
        user_type = self._parent.builder.sig_type

        # Calculate amounts based on side
        if side == BUY:
            # Buying tokens: pay USDC, receive tokens
            # asset_in = tokens (what quoter receives)
            # asset_out = USDC (what quoter pays)
            amount_in = parse_units(rounded_size_str, COLLATERAL_TOKEN_DECIMALS)

            usdc_amount = size_num * price_num
            usdc_amount_str = f"{usdc_amount:.{amount_decimals}f}"
            amount_out = parse_units(usdc_amount_str, COLLATERAL_TOKEN_DECIMALS)

            asset_in = token_id
            asset_out = "0"  # USDC
        else:
            # Selling tokens: pay tokens, receive USDC
            # asset_in = USDC (what quoter receives)
            # asset_out = tokens (what quoter pays)
            usdc_amount = size_num * price_num
            usdc_amount_str = f"{usdc_amount:.{amount_decimals}f}"
            amount_in = parse_units(usdc_amount_str, COLLATERAL_TOKEN_DECIMALS)

            amount_out = parse_units(rounded_size_str, COLLATERAL_TOKEN_DECIMALS)

            asset_in = "0"  # USDC
            asset_out = token_id

        # Post directly to the server
        self._ensure_l2_auth()

        body = {
            "requestId": request_id,
            "assetIn": asset_in,
            "assetOut": asset_out,
            "amountIn": str(amount_in),
            "amountOut": str(amount_out),
            "userType": user_type,
        }
        serialized_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("POST", CREATE_RFQ_QUOTE, body, serialized_body)
        return post(self._build_url(CREATE_RFQ_QUOTE), headers=headers, data=serialized_body)

    def get_rfq_requester_quotes(self, params: Optional[GetRfqQuotesParams] = None) -> dict:
        """
        Get quotes on requests created by the authenticated user (requester view).

        Returns quotes that others have made on your RFQ requests.

        Args:
            params: Optional filter parameters.

        Returns:
            Paginated response with RFQ quotes.
        """
        self._ensure_l2_auth()

        headers = self._get_l2_headers("GET", GET_RFQ_REQUESTER_QUOTES)
        query_params = parse_rfq_quotes_params(params)

        # Build URL with query params
        url = self._build_url(GET_RFQ_REQUESTER_QUOTES)
        if query_params:
            url = f"{url}?{urlencode(query_params, doseq=True)}"

        return get(url, headers=headers)

    def get_rfq_quoter_quotes(self, params: Optional[GetRfqQuotesParams] = None) -> dict:
        """
        Get quotes created by the authenticated user (quoter view).

        Returns quotes that you have made on others' RFQ requests.

        Args:
            params: Optional filter parameters.

        Returns:
            Paginated response with RFQ quotes.
        """
        self._ensure_l2_auth()

        headers = self._get_l2_headers("GET", GET_RFQ_QUOTER_QUOTES)
        query_params = parse_rfq_quotes_params(params)

        # Build URL with query params
        url = self._build_url(GET_RFQ_QUOTER_QUOTES)
        if query_params:
            url = f"{url}?{urlencode(query_params, doseq=True)}"

        return get(url, headers=headers)

    def get_rfq_best_quote(
        self, params: Optional[GetRfqBestQuoteParams] = None
    ) -> dict:
        """
        Get the best quote for an RFQ request.

        Args:
            params: Contains request_id.

        Returns:
            Single quote object representing the best quote.
        """
        self._ensure_l2_auth()

        headers = self._get_l2_headers("GET", GET_RFQ_BEST_QUOTE)

        url = self._build_url(GET_RFQ_BEST_QUOTE)
        if params and params.request_id:
            url = f"{url}?{urlencode({'requestId': params.request_id})}"

        return get(url, headers=headers)

    def cancel_rfq_quote(self, params: CancelRfqQuoteParams) -> str:
        """
        Cancel an RFQ quote.

        Args:
            params: Contains quote_id to cancel.

        Returns:
            "OK" on success.
        """
        self._ensure_l2_auth()

        body = {"quoteId": params.quote_id}
        serialized_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("DELETE", CANCEL_RFQ_QUOTE, body, serialized_body)
        return delete(self._build_url(CANCEL_RFQ_QUOTE), headers=headers, data=serialized_body)

    # =========================================================================
    # Trade execution methods
    # =========================================================================

    def accept_rfq_quote(self, params: AcceptQuoteParams) -> str:
        """
        Accept an RFQ quote (requester side).

        This method:
        1. Fetches the RFQ quote details
        2. Creates a signed order matching the quote
        3. Submits the acceptance with the order

        Args:
            params: Contains request_id, quote_id, and expiration.

        Returns:
            "OK" on success.
        """
        self._ensure_l2_auth()

        resp = self.get_rfq_requester_quotes(
            GetRfqQuotesParams(quote_ids=[params.quote_id])
        )

        if not resp.get("data") or len(resp["data"]) == 0:
            raise Exception("RFQ quote not found")

        rfq_quote = resp["data"][0]
        order_creation_payload = self._get_request_order_creation_payload(rfq_quote)
        price = order_creation_payload.get("price")
        side = order_creation_payload["side"]
        size = float(order_creation_payload["size"])
        token = order_creation_payload["token"]

        order_args = OrderArgs(
            token_id=token,
            price=price,
            size=size,
            side=side,
            expiration=params.expiration,
        )

        order = self._parent.create_order(order_args)

        if not order:
            raise Exception("Error creating order")

        order_dict = order.dict()

        accept_payload = {
            "requestId": params.request_id,
            "quoteId": params.quote_id,
            "owner": self._parent.creds.api_key,
            # Order fields from dict
            "salt": int(order_dict["salt"]),
            "maker": order_dict["maker"],
            "signer": order_dict["signer"],
            "taker": order_dict["taker"],
            "tokenId": order_dict["tokenId"],
            "makerAmount": order_dict["makerAmount"],
            "takerAmount": order_dict["takerAmount"],
            "expiration": int(order_dict["expiration"]),
            "nonce": order_dict["nonce"],
            "feeRateBps": order_dict["feeRateBps"],
            "side": side,
            "signatureType": int(order_dict["signatureType"]),
            "signature": order_dict["signature"],
        }

        self.logger.debug(
            "Accept payload: requestId=%s, quoteId=%s, tokenId=%s, side=%s",
            accept_payload.get("requestId"),
            accept_payload.get("quoteId"),
            accept_payload.get("tokenId"),
            accept_payload.get("side"),
        )
        serialized_body = json.dumps(accept_payload, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("POST", RFQ_REQUESTS_ACCEPT, accept_payload, serialized_body)
        return post(
            self._build_url(RFQ_REQUESTS_ACCEPT),
            headers=headers,
            data=serialized_body,
        )

    def approve_rfq_order(self, params: ApproveOrderParams) -> str:
        """
        Approve an RFQ order (quoter side).

        This method:
        1. Fetches the RFQ quote details
        2. Creates a signed order based on quote parameters
        3. Submits the approval with the order

        Args:
            params: Contains request_id, quote_id, and expiration.

        Returns:
            "OK" on success.
        """
        self._ensure_l2_auth()

        # Step 1: Fetch the RFQ quote
        rfq_quotes = self.get_rfq_quoter_quotes(
            GetRfqQuotesParams(quote_ids=[params.quote_id])
        )

        if not rfq_quotes.get("data") or len(rfq_quotes["data"]) == 0:
            raise Exception("RFQ quote not found")

        rfq_quote = rfq_quotes["data"][0]

        # Step 2: Create an order based on quote details
        # Quoter uses their own quote's side
        side = rfq_quote.get("side", BUY)

        # Determine size based on quote side
        if side == BUY:
            size = rfq_quote.get("sizeIn")
        else:
            size = rfq_quote.get("sizeOut")

        token_id = rfq_quote.get("token")
        price = rfq_quote.get("price")

        order_args = OrderArgs(
            token_id=token_id,
            price=float(price),
            size=float(size),
            side=side,
            expiration=params.expiration,
        )

        order = self._parent.create_order(order_args)

        if not order:
            raise Exception("Error creating order")

        # Step 3: Build approve payload
        order_dict = order.dict()

        approve_payload = {
            "requestId": params.request_id,
            "quoteId": params.quote_id,
            "owner": self._parent.creds.api_key,
            # Order fields from dict
            "salt": int(order_dict["salt"]),
            "maker": order_dict["maker"],
            "signer": order_dict["signer"],
            "taker": order_dict["taker"],
            "tokenId": order_dict["tokenId"],
            "makerAmount": order_dict["makerAmount"],
            "takerAmount": order_dict["takerAmount"],
            "expiration": int(order_dict["expiration"]),
            "nonce": order_dict["nonce"],
            "feeRateBps": order_dict["feeRateBps"],
            "side": side,
            "signatureType": int(order_dict["signatureType"]),
            "signature": order_dict["signature"],
        }
        serialized_body = json.dumps(approve_payload, separators=(",", ":"), ensure_ascii=False)
        headers = self._get_l2_headers("POST", RFQ_QUOTE_APPROVE, approve_payload, serialized_body)
        return post(
            self._build_url(RFQ_QUOTE_APPROVE),
            headers=headers,
            data=serialized_body,
        )

    # =========================================================================
    # Configuration
    # =========================================================================

    def rfq_config(self) -> dict:
        """
        Get RFQ configuration from the server.

        Returns:
            Configuration object with RFQ system parameters.
        """
        self._ensure_l2_auth()

        headers = self._get_l2_headers("GET", RFQ_CONFIG)
        return get(self._build_url(RFQ_CONFIG), headers=headers)

    def _get_request_order_creation_payload(self, quote: dict) -> dict:
        """
        Build the order creation payload for an RFQ request based on quote details.
        """
        raw_match_type = quote.get("matchType", MatchType.COMPLEMENTARY)
        match_type = (
            raw_match_type
            if isinstance(raw_match_type, MatchType)
            else MatchType(str(raw_match_type))
        )

        side = quote.get("side", BUY)

        if match_type == MatchType.COMPLEMENTARY:
            # For BUY <> SELL and SELL <> BUY
            # the order side is opposite the quote side
            token = quote.get("token")
            if not token:
                raise Exception("missing token for COMPLEMENTARY match")
            side = SELL if side == BUY else BUY
            size = quote.get("sizeOut") if side == BUY else quote.get("sizeIn")
            if size is None:
                raise Exception("missing sizeIn/sizeOut for COMPLEMENTARY match")
            price = quote.get("price")
            if price is None:
                raise Exception("missing price for COMPLEMENTARY match")
            price = float(price)
            return {
                "token": token,
                "side": side,
                "size": size,
                "price": price,
            }
        elif match_type in (MatchType.MINT, MatchType.MERGE):
            # BUY<> BUY, SELL <> SELL
            # the order side is the same as the quote side
            token = quote.get("complement")
            if not token:
                raise Exception("missing complement token for MINT/MERGE match")
            size = quote.get("sizeIn") if side == BUY else quote.get("sizeOut")
            if size is None:
                raise Exception("missing sizeIn/sizeOut for MINT/MERGE match")
            price = quote.get("price")
            if price is None:
                raise Exception("missing price for MINT/MERGE match")
            price = float(price)
            # For a MINT or a MERGE, the requester price is the inverse of the quote price
            # 95c Quote to BUY NO, implies that the Requester is buying YES at 5c
            # 45c Quote to SELL NO, implies the Requester is selling YES at 55c
            price = 1 - price
            return {
                "token": token,
                "side": side,
                "size": size,
                "price": price,
            }
        else:
            raise Exception(f"invalid match type: {raw_match_type}")

