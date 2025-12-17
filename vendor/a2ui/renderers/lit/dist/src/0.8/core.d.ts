export * as Events from "./events/events.js";
export * as Types from "./types/types.js";
export * as Primitives from "./types/primitives.js";
export * as Styles from "./styles/index.js";
import * as Guards from "./data/guards.js";
import { create as createSignalA2uiMessageProcessor } from "./data/signal-model-processor.js";
import { A2uiMessageProcessor } from "./data/model-processor.js";
export declare const Data: {
    createSignalA2uiMessageProcessor: typeof createSignalA2uiMessageProcessor;
    A2uiMessageProcessor: typeof A2uiMessageProcessor;
    Guards: typeof Guards;
};
export declare const Schemas: {
    A2UIClientEventMessage: {
        title: string;
        description: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            beginRendering: {
                type: string;
                description: string;
                additionalProperties: boolean;
                properties: {
                    surfaceId: {
                        type: string;
                        description: string;
                    };
                    root: {
                        type: string;
                        description: string;
                    };
                    styles: {
                        type: string;
                        description: string;
                        additionalProperties: boolean;
                        properties: {
                            font: {
                                type: string;
                                description: string;
                            };
                            primaryColor: {
                                type: string;
                                description: string;
                                pattern: string;
                            };
                        };
                    };
                };
                required: string[];
            };
            surfaceUpdate: {
                type: string;
                description: string;
                additionalProperties: boolean;
                properties: {
                    surfaceId: {
                        type: string;
                        description: string;
                    };
                    components: {
                        type: string;
                        description: string;
                        minItems: number;
                        items: {
                            type: string;
                            description: string;
                            additionalProperties: boolean;
                            properties: {
                                id: {
                                    type: string;
                                    description: string;
                                };
                                weight: {
                                    type: string;
                                    description: string;
                                };
                                component: {
                                    type: string;
                                    description: string;
                                    additionalProperties: boolean;
                                    properties: {
                                        Text: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                text: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                usageHint: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        Image: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                url: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                fit: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                                usageHint: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        Icon: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                name: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                            enum: string[];
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                            };
                                            required: string[];
                                        };
                                        Video: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                url: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                            };
                                            required: string[];
                                        };
                                        AudioPlayer: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                url: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                description: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                            };
                                            required: string[];
                                        };
                                        Row: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                children: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        explicitList: {
                                                            type: string;
                                                            items: {
                                                                type: string;
                                                            };
                                                        };
                                                        template: {
                                                            type: string;
                                                            description: string;
                                                            additionalProperties: boolean;
                                                            properties: {
                                                                componentId: {
                                                                    type: string;
                                                                };
                                                                dataBinding: {
                                                                    type: string;
                                                                };
                                                            };
                                                            required: string[];
                                                        };
                                                    };
                                                };
                                                distribution: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                                alignment: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        Column: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                children: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        explicitList: {
                                                            type: string;
                                                            items: {
                                                                type: string;
                                                            };
                                                        };
                                                        template: {
                                                            type: string;
                                                            description: string;
                                                            additionalProperties: boolean;
                                                            properties: {
                                                                componentId: {
                                                                    type: string;
                                                                };
                                                                dataBinding: {
                                                                    type: string;
                                                                };
                                                            };
                                                            required: string[];
                                                        };
                                                    };
                                                };
                                                distribution: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                                alignment: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        List: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                children: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        explicitList: {
                                                            type: string;
                                                            items: {
                                                                type: string;
                                                            };
                                                        };
                                                        template: {
                                                            type: string;
                                                            description: string;
                                                            additionalProperties: boolean;
                                                            properties: {
                                                                componentId: {
                                                                    type: string;
                                                                };
                                                                dataBinding: {
                                                                    type: string;
                                                                };
                                                            };
                                                            required: string[];
                                                        };
                                                    };
                                                };
                                                direction: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                                alignment: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        Card: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                child: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                        Tabs: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                tabItems: {
                                                    type: string;
                                                    description: string;
                                                    items: {
                                                        type: string;
                                                        additionalProperties: boolean;
                                                        properties: {
                                                            title: {
                                                                type: string;
                                                                description: string;
                                                                additionalProperties: boolean;
                                                                properties: {
                                                                    literalString: {
                                                                        type: string;
                                                                    };
                                                                    path: {
                                                                        type: string;
                                                                    };
                                                                };
                                                            };
                                                            child: {
                                                                type: string;
                                                            };
                                                        };
                                                        required: string[];
                                                    };
                                                };
                                            };
                                            required: string[];
                                        };
                                        Divider: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                axis: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                            };
                                        };
                                        Modal: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                entryPointChild: {
                                                    type: string;
                                                    description: string;
                                                };
                                                contentChild: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                        Button: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                child: {
                                                    type: string;
                                                    description: string;
                                                };
                                                primary: {
                                                    type: string;
                                                    description: string;
                                                };
                                                action: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        name: {
                                                            type: string;
                                                        };
                                                        context: {
                                                            type: string;
                                                            items: {
                                                                type: string;
                                                                additionalProperties: boolean;
                                                                properties: {
                                                                    key: {
                                                                        type: string;
                                                                    };
                                                                    value: {
                                                                        type: string;
                                                                        description: string;
                                                                        additionalProperties: boolean;
                                                                        properties: {
                                                                            path: {
                                                                                type: string;
                                                                            };
                                                                            literalString: {
                                                                                type: string;
                                                                            };
                                                                            literalNumber: {
                                                                                type: string;
                                                                            };
                                                                            literalBoolean: {
                                                                                type: string;
                                                                            };
                                                                        };
                                                                    };
                                                                };
                                                                required: string[];
                                                            };
                                                        };
                                                    };
                                                    required: string[];
                                                };
                                            };
                                            required: string[];
                                        };
                                        CheckBox: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                label: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                value: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalBoolean: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                            };
                                            required: string[];
                                        };
                                        TextField: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                label: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                text: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                textFieldType: {
                                                    type: string;
                                                    description: string;
                                                    enum: string[];
                                                };
                                                validationRegexp: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                        DateTimeInput: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                value: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalString: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                enableDate: {
                                                    type: string;
                                                    description: string;
                                                };
                                                enableTime: {
                                                    type: string;
                                                    description: string;
                                                };
                                                outputFormat: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                        MultipleChoice: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                selections: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalArray: {
                                                            type: string;
                                                            items: {
                                                                type: string;
                                                            };
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                options: {
                                                    type: string;
                                                    description: string;
                                                    items: {
                                                        type: string;
                                                        additionalProperties: boolean;
                                                        properties: {
                                                            label: {
                                                                type: string;
                                                                description: string;
                                                                additionalProperties: boolean;
                                                                properties: {
                                                                    literalString: {
                                                                        type: string;
                                                                    };
                                                                    path: {
                                                                        type: string;
                                                                    };
                                                                };
                                                            };
                                                            value: {
                                                                type: string;
                                                                description: string;
                                                            };
                                                        };
                                                        required: string[];
                                                    };
                                                };
                                                maxAllowedSelections: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                        Slider: {
                                            type: string;
                                            additionalProperties: boolean;
                                            properties: {
                                                value: {
                                                    type: string;
                                                    description: string;
                                                    additionalProperties: boolean;
                                                    properties: {
                                                        literalNumber: {
                                                            type: string;
                                                        };
                                                        path: {
                                                            type: string;
                                                        };
                                                    };
                                                };
                                                minValue: {
                                                    type: string;
                                                    description: string;
                                                };
                                                maxValue: {
                                                    type: string;
                                                    description: string;
                                                };
                                            };
                                            required: string[];
                                        };
                                    };
                                };
                            };
                            required: string[];
                        };
                    };
                };
                required: string[];
            };
            dataModelUpdate: {
                type: string;
                description: string;
                additionalProperties: boolean;
                properties: {
                    surfaceId: {
                        type: string;
                        description: string;
                    };
                    path: {
                        type: string;
                        description: string;
                    };
                    contents: {
                        type: string;
                        description: string;
                        items: {
                            type: string;
                            description: string;
                            additionalProperties: boolean;
                            properties: {
                                key: {
                                    type: string;
                                    description: string;
                                };
                                valueString: {
                                    type: string;
                                };
                                valueNumber: {
                                    type: string;
                                };
                                valueBoolean: {
                                    type: string;
                                };
                                valueMap: {
                                    description: string;
                                    type: string;
                                    items: {
                                        type: string;
                                        description: string;
                                        additionalProperties: boolean;
                                        properties: {
                                            key: {
                                                type: string;
                                            };
                                            valueString: {
                                                type: string;
                                            };
                                            valueNumber: {
                                                type: string;
                                            };
                                            valueBoolean: {
                                                type: string;
                                            };
                                        };
                                        required: string[];
                                    };
                                };
                            };
                            required: string[];
                        };
                    };
                };
                required: string[];
            };
            deleteSurface: {
                type: string;
                description: string;
                additionalProperties: boolean;
                properties: {
                    surfaceId: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
};
//# sourceMappingURL=core.d.ts.map