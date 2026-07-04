let handler: (() => boolean) | null = null;

export const setBackHandler = (h: (() => boolean) | null) => {
  handler = h;
};

export const tryConsumeBack = (): boolean => !!(handler && handler());
