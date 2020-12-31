import type {
  ComponentType,
  ComponentPropsWithoutRef,
  HTMLAttributes,
  Context,
} from 'react';

export type PropsFor<T extends string | ComponentType<any>> = T extends string
  ? T extends keyof JSX.IntrinsicElements
    ? JSX.IntrinsicElements[T]
    : T extends ComponentType<any>
    ? ComponentPropsWithoutRef<T>
    : HTMLAttributes<T>
  : T extends ComponentType<any>
  ? ComponentPropsWithoutRef<T>
  : never;

export type FunctionKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: any[]) => any
    ? K
    : never;
}[keyof T];

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends Record<string, any>
  ? {
      [K in keyof T]?: DeepPartial<T[K]>;
    }
  : T;

export type Predicate<Extensions extends Record<string, any>> = (
  node: Node<unknown, Extensions>,
) => boolean;

type MaybeFunctionReturnType<T> = T extends (...args: any[]) => any
  ? ReturnType<T>
  : unknown;

export interface Root<
  Props,
  Context extends Record<string, any> | undefined = undefined
> {
  readonly context: Context;
  mount(): void;
  unmount(): void;
  setProps(props: Partial<Props>): void;
  act<T>(action: () => T, options?: {update?: boolean}): T;
  // Not until we need it...
  // forceUpdate(): void;
}

export interface NodeApi<Props, Extensions extends Record<string, any>> {
  readonly props: Props;
  readonly type: string | ComponentType<any> | null;
  readonly instance: any;
  readonly children: (Node<unknown, Extensions> | string)[];
  readonly descendants: (Node<unknown, Extensions> | string)[];
  readonly text: string;

  prop<K extends keyof Props>(key: K): Props[K];

  is<Type extends ComponentType<any> | string>(
    type: Type,
  ): this is Node<PropsFor<Type>, Extensions>;

  find<Type extends ComponentType<any> | string>(
    type: Type,
    props?: Partial<PropsFor<Type>>,
  ): Node<PropsFor<Type>, Extensions> | null;
  findAll<Type extends ComponentType<any> | string>(
    type: Type,
    props?: Partial<PropsFor<Type>>,
  ): Node<PropsFor<Type>, Extensions>[];
  findWhere<Props = unknown>(
    predicate: Predicate<Extensions>,
  ): Node<Props, Extensions> | null;
  findAllWhere<Props = unknown>(
    predicate: Predicate<Extensions>,
  ): Node<Props, Extensions>[];
  findContext<Type>(context: Context<Type>): Type | undefined;

  trigger<K extends FunctionKeys<Props>>(
    prop: K,
    ...args: DeepPartial<Parameters<Props[K]>>
  ): MaybeFunctionReturnType<NonNullable<Props[K]>>;
  triggerKeypath<T = unknown>(keypath: string, ...args: unknown[]): T;

  debug(options?: DebugOptions): string;
  toString(): string;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export type Node<Props, Extensions extends Record<string, any> = {}> = NodeApi<
  Props,
  Extensions
> &
  Omit<Extensions, keyof Root<any>>;

export interface DebugOptions {
  all?: boolean;
  depth?: number;
  verbosity?: number;
}

export interface HtmlNodeExtensions {
  readonly isDom: boolean;
  readonly domNodes: HTMLElement[];
  readonly domNode: HTMLElement | null;
  readonly html: string;
  readonly text: string;
  data(key: string): string | undefined;
}
