package utils

import "reflect"

func Map[T any, R any](a []T, mapper func(T) R) []R {
	res := make([]R, len(a))
	for i, v := range a {
		res[i] = mapper(v)
	}
	return res
}

func Remove[T any](a []T, v T) []T {
	index := IndexOf(a, v)
	if index == -1 {
		return a
	}

	return Concat(a[:index], a[index+1:])
}

func IndexOf[T any](a []T, v T) int {
	for i, val := range a {
		// stupid compiler doesn't understand T is always comparable to T
		if reflect.DeepEqual(val, v) {
			return i
		}
	}
	return -1
}

func Concat[T any](a []T, b []T) []T {
	res := make([]T, len(a)+len(b))
	copy(res, a)
	copy(res[len(a):], b)
	return res
}
