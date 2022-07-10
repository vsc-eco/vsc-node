actions.init = async () => {
    console.log('hello world! This contract is ready for action!')
    console.log(await state.pull('test'))
    await state.update('test', {
        message: "HELLO WORLD!"
    })
}

//Basic set value action.
actions.set = async ({key, value}) => {
    console.log(key)
    const data = (await state.pull('test-repo')) || {}
    console.log(data)
    data[key] = value;
    await state.update('test-repo', data)
}