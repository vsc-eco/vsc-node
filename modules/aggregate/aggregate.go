package aggregate

type Aggregate struct {
	plugins []Plugin
}

func New(plugins ...Plugin) *Aggregate {
	return &Aggregate{
		plugins,
	}
}

func (a *Aggregate) Run() error {
	if err := a.registerExitHandlers(); err != nil {
		return err
	}

	for _, p := range a.plugins {
		if err := p.Init(); err != nil {
			return err
		}
	}

	for _, p := range a.plugins {
		if err := p.Start(); err != nil {
			return err
		}
	}

	return nil
}

func (a *Aggregate) registerExitHandlers() error {
	// TODO register handler
	_ = func() {
		for _, p := range a.plugins {
			if err := p.Stop(); err != nil {
				panic(err)
			}
		}
	}
	return nil
}
