export type CaptureUIScreenshotsResult = {
    success: true;
    pathOfScreenshots: string;
} | {
    success: false;
    message: string;
}

export interface State<T> {
    data: T;
    reducer?: (cur: T, update: T) => T;
}

export type AuthState = {
    isRequired: false
} | {
    isRequired: true
    credentials: {
        email: string
        password: string
    }
}