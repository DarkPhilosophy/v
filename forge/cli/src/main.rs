fn main() {
    std::process::exit(vforge::main_with(std::env::args().skip(1).collect()));
}
