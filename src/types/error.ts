export function errorAsValue<T>(f: () => T): [T, undefined] | [undefined, any] {
    try {
        return [f(), undefined]
    } catch (e) {
        return [undefined, e]
    }
}