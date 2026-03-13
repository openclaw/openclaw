export interface StringValue {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    /**
     * A fixed, hardcoded string value.
     */
    literalString?: string;
    /**
     * A fixed, hardcoded string value.
     */
    literal?: string;
}
export interface NumberValue {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    /**
     * A fixed, hardcoded number value.
     */
    literalNumber?: number;
    /**
     * A fixed, hardcoded number value.
     */
    literal?: number;
}
export interface BooleanValue {
    /**
     * A data binding reference to a location in the data model (e.g., '/user/name').
     */
    path?: string;
    /**
     * A fixed, hardcoded boolean value.
     */
    literalBoolean?: boolean;
    /**
     * A fixed, hardcoded boolean value.
     */
    literal?: boolean;
}
//# sourceMappingURL=primitives.d.ts.map