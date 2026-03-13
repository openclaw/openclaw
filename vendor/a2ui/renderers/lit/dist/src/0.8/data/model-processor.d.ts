import { ServerToClientMessage, AnyComponentNode, DataValue, Surface, MessageProcessor } from "../types/types";
/**
 * Processes and consolidates A2UIProtocolMessage objects into a structured,
 * hierarchical model of UI surfaces.
 */
export declare class A2uiMessageProcessor implements MessageProcessor {
    #private;
    readonly opts: {
        mapCtor: MapConstructor;
        arrayCtor: ArrayConstructor;
        setCtor: SetConstructor;
        objCtor: ObjectConstructor;
    };
    static readonly DEFAULT_SURFACE_ID = "@default";
    constructor(opts?: {
        mapCtor: MapConstructor;
        arrayCtor: ArrayConstructor;
        setCtor: SetConstructor;
        objCtor: ObjectConstructor;
    });
    getSurfaces(): ReadonlyMap<string, Surface>;
    clearSurfaces(): void;
    processMessages(messages: ServerToClientMessage[]): void;
    /**
     * Retrieves the data for a given component node and a relative path string.
     * This correctly handles the special `.` path, which refers to the node's
     * own data context.
     */
    getData(node: AnyComponentNode, relativePath: string, surfaceId?: string): DataValue | null;
    setData(node: AnyComponentNode | null, relativePath: string, value: DataValue, surfaceId?: string): void;
    resolvePath(path: string, dataContextPath?: string): string;
}
//# sourceMappingURL=model-processor.d.ts.map