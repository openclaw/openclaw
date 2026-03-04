from typing import Optional

import httpx


class PolyException(Exception):
    def __init__(self, msg):
        self.msg = msg


class PolyApiException(PolyException):
    def __init__(self, resp: Optional[httpx.Response] = None, error_msg=None):
        assert resp is not None or error_msg is not None

        if resp is not None:
            self.status_code = resp.status_code
            self.error_msg = self._get_message(resp)
        else:
            self.status_code = None
            self.error_msg = error_msg

    def _get_message(self, resp: httpx.Response):
        try:
            return resp.json()
        except Exception:
            return resp.text

    def __repr__(self):
        return f"PolyApiException[status_code={self.status_code}, error_message={self.error_msg}]"

    def __str__(self):
        return self.__repr__()
