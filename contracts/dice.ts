actions.roll = async () => {
    let result = api.input.included_in.charCodeAt(0) % 2;
    await state.update('last_throw', result)
}
