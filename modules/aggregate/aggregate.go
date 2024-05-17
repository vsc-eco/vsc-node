package aggregate

type Aggregate struct {
	plugins []Plugin
}

var _ Plugin = &Aggregate{}

func New(plugins []Plugin) *Aggregate {
	return &Aggregate{
		plugins,
	}
}

func (a *Aggregate) Run() error {
	if err := a.registerExitHandlers(); err != nil {
		return err
	}

	if err := a.Init(); err != nil {
		return err
	}

	if err := a.Start(); err != nil {
		return err
	}

	return nil
}

func (a *Aggregate) registerExitHandlers() error {
	// TODO register handler
	_ = func() {
		if err := a.Stop(); err != nil {
			panic(err)
		}
	}
	return nil
}

// Init implements Plugin.
func (a *Aggregate) Init() error {
	for _, p := range a.plugins {
		if err := p.Init(); err != nil {
			return err
		}
	}
	return nil
}

// Start implements Plugin.
func (a *Aggregate) Start() error {
	for _, p := range a.plugins {
		if err := p.Start(); err != nil {
			return err
		}
	}
	return nil
}

// Stop implements Plugin.
func (a *Aggregate) Stop() error {
	for _, p := range a.plugins {
		if err := p.Stop(); err != nil {
			return err
		}
	}
	return nil
}
