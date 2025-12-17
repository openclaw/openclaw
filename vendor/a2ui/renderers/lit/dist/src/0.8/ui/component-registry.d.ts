import { CustomElementConstructorOf } from "./ui.js";
export declare class ComponentRegistry {
    private registry;
    register(typeName: string, constructor: CustomElementConstructorOf<HTMLElement>, tagName?: string): void;
    get(typeName: string): CustomElementConstructorOf<HTMLElement> | undefined;
}
export declare const componentRegistry: ComponentRegistry;
//# sourceMappingURL=component-registry.d.ts.map