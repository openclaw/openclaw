export type SimplexControlState = {
  busyCreate: boolean;
  busyRevoke: boolean;
  message: string | null;
  error: string | null;
  addressLink: string | null;
  addressQrDataUrl: string | null;
  latestOneTimeInviteLink: string | null;
  latestOneTimeInviteQrDataUrl: string | null;
};
