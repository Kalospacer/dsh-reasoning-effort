/** The client `Context` members this plugin uses. */
interface ClientContext {
    get(name: string): unknown;
    effect(setup: () => (() => void) | void, label?: string): () => void;
    readonly locale: {
        register(ns: string, dicts: Record<string, unknown>): () => void;
    };
    readonly slots: {
        inject(name: string, mount: () => (() => void) | void): void;
        register(spec: Record<string, unknown>, component: (props: any) => unknown): () => void;
    };
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
