export type KeyLike = {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
};

const IME_PROCESSING_KEY_CODE = 229;

export const isConfirmEnter = (e: KeyLike): boolean =>
  e.key === "Enter" &&
  !e.shiftKey &&
  e.isComposing !== true &&
  e.keyCode !== IME_PROCESSING_KEY_CODE;
