actions.init = async () => {
  await state.update("test", {
    message: "HELLO WORLD!"
  });
};
actions.set = async ({ key, value }) => {
  const data = await state.pull("test-repo") || {};
  data[key] = value;
  await state.update("test-repo", data);
};
actions.mint = async ({ name, recordManifest }) => {
  const lastIdDb = (await state.pull("last_id") || {
    last_id: 0
  }).last_id;
  const nextId = lastIdDb + 1;
  await state.update(`nfts/${nextId}`, {
    name,
    recordManifest
  });
  await state.update(`owners/${nextId}`, {
    owners: [api.input.sender.id]
  });
  await state.update("last_id", {
    last_id: nextId
  });
};
actions.burnNft = async ({}) => {
};
actions.dupTo = async ({
  id,
  destOwner
}) => {
  const data = await state.pull(`owners/${id}`) || {};
  if (data.owners.includes(api.input.sender.id)) {
    const newOwners = [
      ...data.owners,
      destOwner
    ];
    await state.update(`owners/${id}`, {
      ...newOwners,
      owners: newOwners
    });
  }
};
actions.transfer = async ({}) => {
};
