package com.example.sample;

import java.util.List;
import java.util.Optional;
import java.util.Map;

/**
 * Maximum retry count.
 */
public class Sample {

    public static final int MAX_RETRIES = 3;

    private int counter = 0;

    /**
     * A user in the system.
     */
    public static class User {
        public String id;
        public String name;
        public String email;

        public User(String id, String name, String email) {
            this.id = id;
            this.name = name;
            this.email = email;
        }
    }

    /**
     * Status of an entity.
     */
    public enum Status {
        ACTIVE,
        INACTIVE
    }

    /**
     * A service interface.
     */
    public interface Service {
        void init();
        Optional<User> findUser(String id);
    }

    /**
     * Greet a person by name.
     */
    public static String greet(String name) {
        return "Hello, " + name + "!";
    }

    /**
     * Fetch data from a URL.
     */
    public byte[] fetchData(String url) throws Exception {
        return new byte[0];
    }

    private void privateHelper() {
        // internal
    }
}
